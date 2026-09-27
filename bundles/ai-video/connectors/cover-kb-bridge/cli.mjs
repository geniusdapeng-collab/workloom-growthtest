#!/usr/bin/env node
/**
 * cover-kb-cli —— 封面知识库工位命令行（封面设计师数字员工的"手"）
 *
 * 用法：
 *   cover-kb-cli health                                    # 完整性自检 + KB ↔ cover-platforms.ts 交叉核对
 *   cover-kb-cli index [--json]                            # 篇目索引（14 篇 + 触发关键词）
 *   cover-kb-cli search "<关键词>" [--top 3] [--json]       # 意图检索 → 命中篇目 + 相关条目
 *   cover-kb-cli profile <平台ID> [--json]                  # 平台规范直取（§四 参数速查）
 *   cover-kb-cli recipe <平台> <题材> [账号类型] [--json]    # 组合配方：平台 + 题材 + 钩子短名单
 *   cover-kb-cli enrich --platform X [--theme Y] [--account Z] [--json]
 *                                                          # 注入载荷：≤3 条，每条带 trace
 *   cover-kb-cli hooks                                     # HOOK-001 公式 ID 清单
 *
 * 口径纪律（KB 检索总则）：平台数字（画幅/安全区/标题带/字数上限）最终以代码
 * `packages/video-studio/src/cover-platforms.ts` 为准。链内调用把代码规格当 `spec` 传入，
 * 两者冲突时以代码为准并把差异写进 `conflicts`（进提案池，不改 KB 原文）。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { parseAccountProfileYaml } from "./account-profile.mjs";
import {
  HOOK_FORMULA_IDS,
  PLATFORM_KB_IDS,
  crossCheckPlatformSpecs,
  enrichCoverHints,
  inferTheme,
  kbStatus,
  listThemes,
  loadKb,
  normalizeAccountProfile,
  platformProfile,
  recipe,
  searchKb
} from "./core.mjs";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../..");
const DEFAULT_KB = path.resolve(REPO_ROOT, "bundles/ai-video/library/cover-kb");
const DEFAULT_SPEC_TS = path.resolve(REPO_ROOT, "packages/video-studio/src/cover-platforms.ts");
const DEFAULT_ACCOUNT_DIR = path.resolve(REPO_ROOT, "bundles/ai-video/library/account-profiles");

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

/** 读账号档案（id 或路径）；不存在时返回 { error } —— 不静默降级 */
function loadAccount(accountIdOrPath, accountDir) {
  const raw = String(accountIdOrPath ?? "").trim();
  if (!raw) return null;
  const file = /\.ya?ml$/.test(raw) || raw.includes("/")
    ? path.resolve(raw)
    : path.join(accountDir, `${raw}.yml`);
  if (!fs.existsSync(file)) return { error: true, file };
  const text = fs.readFileSync(file, "utf8");
  return { file, text };
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
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
      const specFile = typeof flags["spec-file"] === "string" ? path.resolve(flags["spec-file"]) : DEFAULT_SPEC_TS;
      const specTs = fs.existsSync(specFile) ? fs.readFileSync(specFile, "utf8") : "";
      const crossCheck = specTs ? crossCheckPlatformSpecs(kb, specTs) : [];
      const drifts = crossCheck.filter((row) => row.diffs.length > 0);
      const payload = {
        ...status,
        expectedTopics: 14,
        topicsComplete: status.topics === 14,
        platformCrossCheck: crossCheck,
        platformDrifts: drifts,
        note: "KB 数字与 cover-platforms.ts 冲突时以代码为准；漂移进提案池，不改 KB 原文"
      };
      if (json) line(JSON.stringify(payload, null, 2));
      else {
        line(`知识库：${status.dir}`);
        line(`篇目 ${status.topics}/14 · 映射行 ${status.mappingRows} · 参数行 ${status.paramRows} · ${(status.bytes / 1024).toFixed(0)}KB`);
        for (const topic of status.missingTopics) line(`⚠ 索引引用但缺篇：${topic.id} ${topic.title}`);
        if (status.untrackedTopics.length > 0) line(`⚠ 目录有篇目但索引未登记：${status.untrackedTopics.join("、")}`);
        if (status.topicsWithEmptyMappings.length > 0) line(`⚠ 无映射行的篇目：${status.topicsWithEmptyMappings.join("、")}`);
        if (status.topicsWithEmptyParams.length > 0) line(`⚠ 无参数速查行的篇目：${status.topicsWithEmptyParams.join("、")}`);
        if (status.duplicateIds.length > 0) line(`⚠ 篇目编号重复：${status.duplicateIds.join("、")}`);
        if (specTs) {
          line(drifts.length === 0
            ? `平台交叉核对：${crossCheck.length} 个平台与 cover-platforms.ts 一致（无漂移）`
            : `⚠ 平台交叉核对发现 ${drifts.length} 处漂移（以代码为准）：`);
          for (const row of drifts) for (const diff of row.diffs) line(`   · ${row.platformId}（${row.kbId}）：${diff}`);
        }
      }
      return status.ok ? 0 : 3;
    }
    case "index": {
      if (json) {
        line(JSON.stringify({
          status: kbStatus(kb),
          topics: kb.topics.map((t) => ({
            id: t.id,
            title: t.title,
            version: t.version,
            params: t.params.length || (t.paramMatrix?.rows.length ?? 0),
            mapping: t.mapping.length + t.matrix.length,
            keywords: kb.index.topics.find((i) => i.id === t.id)?.keywords ?? []
          }))
        }, null, 2));
        return 0;
      }
      const status = kbStatus(kb);
      line(`封面知识库：${status.topics} 篇 · 映射 ${status.mappingRows} 行 · 参数 ${status.paramRows} 行`);
      for (const topic of kb.topics) {
        const keywords = kb.index.topics.find((i) => i.id === topic.id)?.keywords ?? [];
        line(`  ${topic.id}  ${topic.title}  参数 ${topic.params.length || (topic.paramMatrix?.rows.length ?? 0)}`
          + ` · 映射 ${topic.mapping.length + topic.matrix.length}${keywords.length > 0 ? `  触发词：${keywords.join("/")}` : ""}`);
      }
      for (const hint of kb.index.callHints) line(`  ↳ 调用建议：${hint}`);
      return 0;
    }
    case "search": {
      const keyword = String(positional[0] ?? flags.text ?? flags.q ?? "").trim();
      if (!keyword) { process.stderr.write('需要关键词：cover-kb-cli search "小红书 3:4"\n'); return 2; }
      const result = searchKb(kb, keyword.slice(0, 20), { top: Number(flags.top ?? 3) });
      if (json) { line(JSON.stringify(result, null, 2)); return 0; }
      if (result.hits.length === 0) {
        line(`零命中：知识库未收录「${keyword}」（允许无 KB 出稿，记 fallback）`);
        return 0;
      }
      for (const hit of result.hits) {
        line(`[${hit.kbId}] ${hit.title}（score ${hit.score}）${hit.reasons.length > 0 ? ` · 命中：${hit.reasons.join("/")}` : ""}`);
        for (const entry of hit.entries) line(`   · ${entry.text}`);
      }
      return 0;
    }
    case "profile": {
      const platformId = String(positional[0] ?? flags.platform ?? "").trim();
      if (!platformId) { process.stderr.write("需要平台 ID：cover-kb-cli profile xiaohongshu\n"); return 2; }
      const profile = platformProfile(kb, platformId);
      if (!profile) {
        process.stderr.write(`未收录平台：${platformId}（已登记：${Object.keys(PLATFORM_KB_IDS).join("/")}）\n`);
        return 3;
      }
      if (json) { line(JSON.stringify(profile, null, 2)); return 0; }
      line(`${profile.title}（${profile.kbId}）`);
      for (const param of profile.params) line(`  ${param.key}：${param.value}`);
      if (profile.topPitfall) line(`  头号误区：${profile.topPitfall.mistake} → ${profile.topPitfall.correct}`);
      line("  口径提示：平台数字最终以 packages/video-studio/src/cover-platforms.ts 为准（代码规格优先）");
      return 0;
    }
    case "recipe": {
      const [platform, theme, accountType] = positional;
      if (!platform) { process.stderr.write("需要平台：cover-kb-cli recipe douyin 知识科普 知识号\n"); return 2; }
      const result = recipe(kb, { platform, theme, accountType });
      if (json) { line(JSON.stringify(result, null, 2)); return 0; }
      if (!result.platform) { process.stderr.write(`未收录平台：${platform}\n`); return 3; }
      line(`平台：${result.platform.title}`);
      for (const param of result.platform.params) line(`  ${param.key}：${param.value}`);
      if (result.theme) line(`题材：${result.theme.key} → ${result.theme.value}`);
      else if (theme) line(`题材「${theme}」未收录（THEME-001 已收录：${listThemes(kb).join("/")}）`);
      if (result.palette) line(`配色字体：${result.palette.action}`);
      if (result.hooks.length > 0) line(`钩子短名单：${result.hooks.map((h) => `${h.id}=${h.structure}`).join("；")}`);
      if (result.accountNote) line(`账号类型：${result.accountType} → ${result.accountNote}`);
      return 0;
    }
    case "enrich": {
      const platform = String(flags.platform ?? positional[0] ?? "").trim();
      if (!platform) { process.stderr.write("需要 --platform <平台ID>\n"); return 2; }
      let spec = null;
      if (typeof flags["spec-file"] === "string") {
        const doc = JSON.parse(fs.readFileSync(path.resolve(flags["spec-file"]), "utf8"));
        spec = doc?.platforms?.[platform] ?? doc?.[platform] ?? doc?.spec ?? null;
      }
      const accountDir = typeof flags["account-dir"] === "string"
        ? path.resolve(flags["account-dir"])
        : DEFAULT_ACCOUNT_DIR;
      const account = typeof flags.account === "string" ? loadAccount(flags.account, accountDir) : null;
      if (account?.error) { process.stderr.write(`账号档案不存在：${account.file}\n`); return 2; }
      const normalized = account ? normalizeAccountProfile(parseAccountProfileYaml(account.text)) : null;
      const inferred = (flags.theme === undefined || flags.theme === true)
        ? inferTheme(kb, [flags.text, flags.goal].filter((v) => typeof v === "string").join(" "))
        : null;
      const theme = typeof flags.theme === "string" ? flags.theme : (inferred?.theme ?? "");
      const payload = enrichCoverHints(kb, {
        platformId: platform,
        spec,
        theme,
        accountType: normalized?.accountType ?? null,
        hookBias: normalized?.hookBias ?? []
      });
      const notes = [...(payload.notes ?? []), ...(normalized?.notes ?? [])];
      if (json) { line(JSON.stringify({ ...payload, notes }, null, 2)); return payload.fallback ? 4 : 0; }
      if (payload.fallback) {
        line(`平台「${platform}」无 KB 篇目 → 无注入（退化为现有行为）`);
        for (const note of notes) line(`  · ${note}`);
        return 4;
      }
      line(`注入 ${payload.hints.length} 条（上限 3）：`);
      payload.hints.forEach((hint, i) => line(`  ${i + 1}) ${hint}`));
      line(`trace：${payload.trace.map((t) => `${t.kbId}${t.section}(${t.reason})`).join("；")}`);
      for (const conflict of payload.conflicts) line(`  ⚠ 矛盾闸：${conflict}`);
      for (const note of notes) line(`  · ${note}`);
      return 0;
    }
    case "hooks": {
      line(`HOOK-001 公式 ID：${HOOK_FORMULA_IDS.join(" / ")}`);
      return 0;
    }
    default:
      process.stderr.write("用法：cover-kb-cli <health|index|search|profile|recipe|enrich|hooks> [--flags]\n");
      return 2;
  }
}

process.exit(main());
