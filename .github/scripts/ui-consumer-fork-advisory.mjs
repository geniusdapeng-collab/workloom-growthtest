#!/usr/bin/env node
/**
 * 分叉仓 UI 消费契约告警分类器（GitHub 镜像专用）。
 *
 * 为什么需要它：
 *   `scripts/verify-ui-consumer.mjs` 是**基座严格门禁**，会对行业扩展面
 *   （`apps/{web,webb,webc}/src/extensions/**`、各仓在 `.workloom-ui-governance.json`
 *   里声明的 `industryExtensionPaths` 等）中的"中文边界 / 文字出口 / 动态值映射"发现判红。
 *   舰队规范对**已声明分叉容差的仓**（`lane = "experiment"` 或
 *   `tolerateExtensionSnapshotOverlap = true`）明确规定：这些发现降级为 advisories
 *   （保留可见性，不阻断），否则分叉仓的三端产品层会被基座门禁永久判红。
 *
 * 本脚本不修改门禁实现（`verify-ui-consumer.mjs` 的指纹绑定在治理状态里，只能由
 * stable 升级 PR 更新），只在 GitHub 侧复刻基座 rollout 的**分叉降级口径**
 * （`sync/ui-upgrade-pr.mjs#splitForkContractAdvisories`，T-2026-0929-0001 follow-up）：
 *   · 已声明分叉容差 → 该门禁的全部发现降级为 advisories（逐条保留可见、不阻断），
 *     并额外标出不在本仓声明扩展路径内的发现（建议另立产品迁移任务卡）；
 *   · 未声明分叉容差 → 原样按基座严格口径退出 1；
 *   · 门禁失败却解析不出任何发现（疑似工具异常）或分叉状态不可读 → 退出 1（fail-closed）。
 *
 * 用法（CI 内）：
 *   node scripts/verify-ui-consumer.mjs --repo . --require-governance-state 2>&1 | \
 *     node .github/scripts/ui-consumer-fork-advisory.mjs --repo .
 * 自测：node .github/scripts/ui-consumer-fork-advisory.mjs --self-test
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 舰队公认的行业扩展目录（与基座 ui-governance-rules.mjs 的 isIndustryExtensionSource 同口径）。 */
export const CANONICAL_INDUSTRY_PATTERNS = Object.freeze([
  "apps/*/src/extensions/**",
  "apps/*/src/projections/**",
  "apps/*/src/config/industry/**",
  "apps/*/src/theme/industry/**",
  "apps/*/public/industry/**",
]);

export function globToRegExp(glob) {
  let pattern = String(glob).replace(/[.+^${}()|[\]\\]/g, "\\$&");
  pattern = pattern.replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${pattern}$`, "u");
}

/** 分叉容差声明（与 scripts/verify-client-foundation-consumer.mjs 同一开关）。 */
export function isForkDeclared(governance) {
  return governance?.lane === "experiment" || governance?.tolerateExtensionSnapshotOverlap === true;
}

export function readForkDeclaration(repo) {
  const errors = [];
  const governancePath = join(repo, ".workloom-ui-governance.json");
  if (!existsSync(governancePath)) {
    return { declared: false, patterns: [], errors: [`缺少 .workloom-ui-governance.json，无法确认分叉声明`] };
  }
  let governance;
  try {
    governance = JSON.parse(readFileSync(governancePath, "utf8"));
  } catch (error) {
    return { declared: false, patterns: [], errors: [`${".workloom-ui-governance.json"} 不是有效 JSON：${String(error?.message ?? error).split("\n")[0]}`] };
  }
  const declared = isForkDeclared(governance);
  const patterns = [...CANONICAL_INDUSTRY_PATTERNS];
  for (const file of [".workloom-ui-governance.json", ".workloom-client-extensions.json"]) {
    const path = join(repo, file);
    if (!existsSync(path)) continue;
    let doc;
    try {
      doc = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      errors.push(`${file} 不是有效 JSON：${String(error?.message ?? error).split("\n")[0]}`);
      continue;
    }
    const list = Array.isArray(doc?.industryExtensionPaths) ? doc.industryExtensionPaths : [];
    for (const pattern of list) {
      if (typeof pattern !== "string" || !pattern.startsWith("apps/") || pattern.includes("..") || pattern.includes("\\")) {
        errors.push(`仓级行业扩展路径非法：${String(pattern)}`);
        continue;
      }
      if (!patterns.includes(pattern)) patterns.push(pattern);
    }
  }
  return { declared, patterns, errors };
}

const FINDING_RE = /^\s*·\s+(\S+?)(?::\d+)?\s/u;

/**
 * 把门禁输出分类：落在本仓声明扩展路径内的发现，与不在声明范围内的发现。
 * 两者对已声明分叉仓都降级（与基座 rollout 同口径），但后者的可见性优先级更高。
 */
export function classifyFindings(output, patterns) {
  const lines = String(output).split("\n");
  const extension = [];
  const outside = [];
  for (const line of lines) {
    if (!line.trimStart().startsWith("·")) continue;
    const match = FINDING_RE.exec(line);
    const path = match?.[1] ?? null;
    if (path && patterns.some((pattern) => globToRegExp(pattern).test(path))) extension.push(line.trim());
    else outside.push(line.trim());
  }
  return { extension, outside, total: extension.length + outside.length };
}

function summarizeExtensions(extension) {
  const buckets = new Map();
  for (const line of extension) {
    const path = FINDING_RE.exec(line)?.[1] ?? "(未知路径)";
    const parts = path.split("/");
    const key = parts.length >= 4 ? parts.slice(0, 4).join("/") : path;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => `${key}(${count})`)
    .join(" · ");
}

export function selfTest() {
  const failures = [];
  const expect = (label, condition) => { if (!condition) failures.push(label); };
  expect("glob ** 应匹配多级路径", globToRegExp("apps/*/src/pages/**").test("apps/web/src/pages/p0/P0.tsx"));
  expect("glob * 不应跨目录", !globToRegExp("apps/*/src/pages/**").test("apps/web/src/pages.tsx"));
  expect("experiment 车道即声明分叉", isForkDeclared({ lane: "experiment" }));
  expect("显式容差开关即声明分叉", isForkDeclared({ tolerateExtensionSnapshotOverlap: true }));
  expect("普通行业车道未声明分叉", !isForkDeclared({ lane: "industry" }));

  const patterns = [...CANONICAL_INDUSTRY_PATTERNS, "apps/*/src/pages/**"];
  const allExtension = [
    "❌ 行业仓 UI 消费门禁失败（2 项）",
    "  · apps/web/src/extensions/ai-video/pages/Assets.tsx:70 客户端文字出口中的 e.message 必须先经过中文映射或编号脱敏（…）",
    "  · apps/web/src/pages/p0/P0.tsx:12 客户端文字出口中的 v 必须先经过中文映射或编号脱敏（…）",
  ].join("\n");
  const classifiedOk = classifyFindings(allExtension, patterns);
  expect("扩展面发现应归类为扩展内", classifiedOk.extension.length === 2 && classifiedOk.outside.length === 0);

  const mixed = [
    "❌ 行业仓 UI 消费门禁失败（2 项）",
    "  · apps/web/src/extensions/ai-video/pages/Assets.tsx:70 客户端文字出口中的 e.message 必须先经过中文映射或编号脱敏（…）",
    "  · apps/webb 未实际渲染共享基座组件 共享表单控件（Input、Select、Textarea、Checkbox、Switch 至少一种）",
  ].join("\n");
  const classifiedMixed = classifyFindings(mixed, patterns);
  expect("声明范围外的发现应单独标出", classifiedMixed.extension.length === 1 && classifiedMixed.outside.length === 1);

  const noPath = classifyFindings("❌ 行业仓 UI 消费门禁失败（1 项）\n  · 缺少 .workloom-ui-governance.json", patterns);
  expect("解析不出路径的发现仍计入总数", noPath.total === 1 && noPath.extension.length === 0);

  if (failures.length) {
    console.error(`✗ 分叉仓 UI 告警分类器自检失败：${failures.join("；")}`);
    process.exit(1);
  }
  console.log("✓ 分叉仓 UI 告警分类器自检通过（glob / 分叉声明 / 扩展内 / 扩展外 / fail-closed）");
}

function main() {
  const args = process.argv.slice(2);
  const value = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  if (args.includes("--self-test")) return selfTest();

  const repo = resolve(value("--repo", "."));
  const chunks = [];
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    const output = chunks.join("");
    const { declared, patterns, errors } = readForkDeclaration(repo);
    if (errors.length) {
      console.error("❌ 分叉声明不可读，拒绝降级：");
      for (const error of errors) console.error(`  · ${error}`);
      process.exit(1);
    }
    if (!declared) {
      console.error("❌ 仓库未声明分叉容差（lane=experiment 或 tolerateExtensionSnapshotOverlap=true），按基座严格口径处理：");
      console.error(output);
      process.exit(1);
    }
    const { extension, outside, total } = classifyFindings(output, patterns);
    if (!total) {
      console.error("❌ 门禁失败但没有可归类的发现（疑似工具异常），拒绝降级：");
      console.error(output);
      process.exit(1);
    }
    console.log(`::warning::分叉仓 UI 消费契约 advisories：${total} 项（基座 rollout 同口径：已声明分叉仓仅记录不阻断；分布 ${summarizeExtensions(extension)}）`);
    if (outside.length) {
      console.log(`::notice::其中 ${outside.length} 项不在本仓声明的行业扩展路径内，建议另立产品迁移任务卡逐条收敛：`);
      for (const line of outside) console.log(`  ${line}`);
    }
    console.log("—— 以下为门禁原始输出（保留可见性，可另立产品迁移任务卡）——");
    console.log(output);
    process.exit(0);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
