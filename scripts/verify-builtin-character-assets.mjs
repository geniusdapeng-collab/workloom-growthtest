#!/usr/bin/env node
/**
 * 内置角色资产与声明一致性门禁（视频行业包 · T-2026-0925-0004）
 *
 * 背景：本仓**自带**默认模特「陈卓」（`chen-zhuo`）——角色档案 + 8 角度定妆照随仓分发；
 * 镜头卡不写 `character` 时，出片链路自动采用 `bundles/ai-video/library/characters/registry.json#defaultModel`。
 * 但新下载项目的开发者与 AI Agent 常以为"仓库里没有人物资产"而重复建档、或找不到定妆照，
 * 因此本门禁把「资产在 + 声明在」一起守住：任一侧被删都会红灯。
 *
 * 本地直接运行：node scripts/verify-builtin-character-assets.mjs
 * 接线说明：把它接进流水线需按协议 §3 人审后，在 `.cnb.yml` 的 static-gate「产品身份与行业包治理」
 * stage 追加一行 `node scripts/verify-builtin-character-assets.mjs`（与 `pnpm product:verify` 同批执行）。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const bundlesRoot = path.join(root, "bundles");
const errors = [];

try {
  execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, stdio: "ignore" });
} catch {
  errors.push("不在 Git 仓库内运行：内置角色资产门禁需要仓库根目录（scripts/verify-builtin-character-assets.mjs）");
}

const charactersRoot = path.join(bundlesRoot, "ai-video", "library", "characters");
const registryFile = path.join(charactersRoot, "registry.json");

if (!fs.existsSync(registryFile)) {
  errors.push("缺少内置角色库清单：bundles/ai-video/library/characters/registry.json（内置默认模特随仓分发，不得删除）");
} else {
  let registry = null;
  try {
    registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  } catch {
    errors.push("内置角色库清单不是合法 JSON：bundles/ai-video/library/characters/registry.json");
  }

  const defaultModelId = String(registry?.defaultModel ?? "");
  const models = Array.isArray(registry?.models) ? registry.models : [];
  const defaultModel = models.find((model) => model?.id === defaultModelId) ?? null;

  if (!defaultModelId || !defaultModel) {
    errors.push(`内置默认模特不可解析：registry.json#defaultModel=${JSON.stringify(defaultModelId)} 在 models[] 中没有对应档案`);
  } else {
    const archiveDir = path.resolve(root, String(defaultModel.archive ?? ""));
    const profileFile = path.join(archiveDir, "profile.json");
    if (!defaultModel.archive || !archiveDir.startsWith(`${root}${path.sep}`) || !fs.existsSync(profileFile)) {
      errors.push(`内置默认模特档案缺失或越出仓库：${String(defaultModel.archive ?? "未声明 archive")}`);
    } else {
      let profile = null;
      try {
        profile = JSON.parse(fs.readFileSync(profileFile, "utf8"));
      } catch {
        errors.push(`内置默认模特档案不是合法 JSON：${path.relative(root, profileFile)}`);
      }

      const sets = Array.isArray(profile?.portraitSets) ? profile.portraitSets : [];
      const activeSet = sets.find((set) => set?.active) ?? sets.at(-1) ?? null;
      const setDir = activeSet ? path.join(archiveDir, String(activeSet.dir ?? "")) : "";
      const angleFile = (angle) => {
        if (!setDir || !fs.existsSync(setDir)) return null;
        return fs.readdirSync(setDir).find((name) => /\.(png|jpe?g|webp)$/i.test(name)
          && (() => {
            const stem = name.replace(/\.[^.]+$/, "");
            return stem === angle || stem.endsWith(`-${angle}`) || stem.endsWith(`_${angle}`);
          })()) ?? null;
      };

      /** 与出片链路 G5 定妆照门同口径：front / threeQuarter / closeup / side 四个必需角度齐备且 >50KB */
      for (const angle of ["front", "threeQuarter", "closeup", "side"]) {
        const hit = angleFile(angle);
        if (!hit) {
          errors.push(`内置默认模特缺少必需角度定妆照：${angle}（${path.relative(root, setDir || archiveDir)}）`);
        } else if (fs.statSync(path.join(setDir, hit)).size < 50_000) {
          errors.push(`内置默认模特定妆照过小（疑似占位图）：${path.relative(root, path.join(setDir, hit))}`);
        }
      }
    }

    /**
     * 声明一致性：新下载项目的开发者与 AI Agent 主要靠这三处发现内置角色资产，
     * 任一被删即视为"能力还在但没人找得到"，红灯并要求同步更新（见 README / 文档索引 / 目录说明）。
     */
    for (const [rel, label] of [
      ["README.md", "README 项目首页"],
      ["docs/character-registry.md", "角色库权威文档"],
      ["bundles/ai-video/library/characters/README.md", "角色库目录内说明"],
      ["docs/capability-map.md", "Agent 全量能力清单"],
    ]) {
      const file = path.join(root, rel);
      const content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      if (!content.includes(defaultModelId)) {
        errors.push(`内置默认模特「${defaultModelId}」未在${label}声明：${rel}（新下载项目与 AI Agent 靠它发现内置角色资产）`);
      }
    }

    /**
     * 2 号及以后的内置模特（2026-09-28 T-2026-0928-0002）：
     * 每个登记条目都必须"资产在 + 声明在"——档案可解析、四角度齐备且非占位图，
     * 并在角色库权威文档与目录说明里能被找到；默认绑定仍由 defaultModel 单独守住。
     */
    for (const model of models) {
      const id = String(model?.id ?? "");
      if (!id) {
        errors.push("内置角色库清单存在缺少 id 的模特条目");
        continue;
      }
      const archiveDir = path.resolve(root, String(model.archive ?? ""));
      const profileFile = path.join(archiveDir, "profile.json");
      if (!model.archive || !archiveDir.startsWith(`${root}${path.sep}`) || !fs.existsSync(profileFile)) {
        errors.push(`内置模特「${id}」档案缺失或越出仓库：${String(model.archive ?? "未声明 archive")}`);
        continue;
      }
      let profile = null;
      try {
        profile = JSON.parse(fs.readFileSync(profileFile, "utf8"));
      } catch {
        errors.push(`内置模特「${id}」档案不是合法 JSON：${path.relative(root, profileFile)}`);
        continue;
      }
      if (profile?.id !== id) errors.push(`内置模特「${id}」档案 id 与清单不一致：${String(profile?.id ?? "未声明")}`);
      const sets = Array.isArray(profile?.portraitSets) ? profile.portraitSets : [];
      const activeSet = sets.find((set) => set?.active) ?? sets.at(-1) ?? null;
      const setDir = activeSet ? path.join(archiveDir, String(activeSet.dir ?? "")) : "";
      const angleFile = (angle) => {
        if (!setDir || !fs.existsSync(setDir)) return null;
        return fs.readdirSync(setDir).find((name) => /\.(png|jpe?g|webp)$/i.test(name)
          && (() => {
            const stem = name.replace(/\.[^.]+$/, "");
            return stem === angle || stem.endsWith(`-${angle}`) || stem.endsWith(`_${angle}`);
          })()) ?? null;
      };
      for (const angle of ["front", "threeQuarter", "closeup", "side"]) {
        const hit = angleFile(angle);
        if (!hit) errors.push(`内置模特「${id}」缺少必需角度定妆照：${angle}（${path.relative(root, setDir || archiveDir)}）`);
        else if (fs.statSync(path.join(setDir, hit)).size < 50_000) errors.push(`内置模特「${id}」定妆照过小（疑似占位图）：${path.relative(root, path.join(setDir, hit))}`);
      }
      if (id !== defaultModelId) {
        for (const [rel, label] of [
          ["docs/character-registry.md", "角色库权威文档"],
          ["bundles/ai-video/library/characters/README.md", "角色库目录内说明"],
        ]) {
          const content = fs.existsSync(path.join(root, rel)) ? fs.readFileSync(path.join(root, rel), "utf8") : "";
          if (!content.includes(id)) errors.push(`内置模特「${id}」未在${label}声明：${rel}（非默认模特也必须可被找到，且不得改写默认绑定）`);
        }
      }
    }
  }
}

if (errors.length) {
  console.error(["内置角色资产与声明一致性检查失败：", ...errors.map((error) => `- ${error}`)].join("\n"));
  process.exit(1);
}

console.log("内置角色资产与声明一致性检查通过：全部登记模特档案可解析、四角度定妆照齐备；默认模特声明在首页/文档/能力清单/目录说明四处同步，非默认模特在权威文档与目录说明可找到。");
