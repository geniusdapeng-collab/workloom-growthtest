// verify-talkcraft-license.mjs —— talkcraft 引擎的许可闸（CI 硬拦）· T-2026-0926-0008
//
// 背景：上游 `Vincentwei1021/video-talkcraft` 采用 **PolyForm Noncommercial 1.0.0**
// （"any commercial use of the toolkit requires prior authorization from the author"）。
// 本仓是商用产品仓库，把上游源码（卡 tsx / 管线脚本）提交进 git = 未授权再分发。
//
// 本闸做三件事（任一不满足即 exit 1）：
//   ① **反向检查**：git 索引里不得出现上游源码路径（vendor/talkcraft/**、var/talkcraft-* 等）；
//   ② 若本地装了引擎（vendor/talkcraft/ 存在）：LICENSE 与 PINNED 必须在场；
//   ③ 若引擎目录有 LICENSE-GRANT.md（作者授权文件）：必须含授权方/被授权方/范围/日期四要素。
//
// 用法：node scripts/ci/verify-talkcraft-license.mjs [--self-test]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENGINE_DIR = resolve(process.env.TALKCRAFT_ENGINE_DIR?.trim() || join(REPO_ROOT, "vendor/talkcraft"));

/** 上游源码的路径特征（出现在 git 索引里即违规） */
export const FORBIDDEN_TRACKED = [
  /^vendor\/talkcraft\//,
  /^var\/talkcraft-/,
  /^vendor\/talkcraft\/template\/cards\/.+\.tsx$/,
  /^vendor\/talkcraft\/scripts\/(render_shots\.mjs|timestamps_cpu\.py|card_lint\.py)$/,
];

export function findViolations(trackedFiles) {
  return trackedFiles.filter((file) => FORBIDDEN_TRACKED.some((re) => re.test(file)));
}

export function checkGrantFile(text) {
  const required = [
    { key: "授权方", re: /授权方[:：]?\s*\S+/ },
    { key: "被授权方", re: /被授权方[:：]?\s*\S+/ },
    { key: "范围", re: /范围[:：]?\s*\S+/ },
    { key: "日期", re: /(日期|签署日期)[:：]?\s*\S+/ },
  ];
  return required.filter((item) => !item.re.test(text)).map((item) => item.key);
}

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

function selfTest() {
  const violations = findViolations([
    "apps/server/src/video/explainer/router.ts",
    "vendor/talkcraft/scripts/render_shots.mjs",
    "packages/video-studio/explainer-template/src/Main.tsx",
  ]);
  const okA = violations.length === 1 && violations[0].startsWith("vendor/talkcraft/");
  const missing = checkGrantFile("商业授权书\n授权方：Vincent Wei\n被授权方：WorkLoom\n");
  const okB = missing.length === 2 && missing.includes("范围") && missing.includes("日期");
  const okC = checkGrantFile("授权方：Vincent Wei\n被授权方：WorkLoom\n范围：企业级口播视频生产\n日期：2026-09-26\n").length === 0;
  if (!okA || !okB || !okC) {
    console.error(`self-test FAIL（路径反向检查=${okA} 缺项识别=${okB} 完整识别=${okC}）`);
    process.exit(1);
  }
  console.log("self-test PASS：路径反向检查 + 授权四要素校验");
}

function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }
  const failures = [];

  const violations = findViolations(trackedFiles());
  if (violations.length > 0) {
    failures.push(
      `上游源码被提交进 git（${violations.length} 个）：${violations.slice(0, 5).join("、")}`
      + "\n  → talkcraft 引擎采用 PolyForm Noncommercial：本仓不得再分发。"
      + "\n  → 处置：git rm --cached 这些路径，并确认 .gitignore 已含 vendor/talkcraft/ 与 var/talkcraft-*。",
    );
  }

  if (existsSync(ENGINE_DIR)) {
    if (!existsSync(join(ENGINE_DIR, "LICENSE"))) failures.push(`本地引擎缺 LICENSE 原文：${join(ENGINE_DIR, "LICENSE")}`);
    if (!existsSync(join(ENGINE_DIR, "PINNED"))) failures.push(`本地引擎缺 PINNED（commit/许可留痕）：${join(ENGINE_DIR, "PINNED")}`);
    const grantPath = join(ENGINE_DIR, "LICENSE-GRANT.md");
    if (existsSync(grantPath)) {
      const missing = checkGrantFile(readFileSync(grantPath, "utf8"));
      if (missing.length > 0) failures.push(`LICENSE-GRANT.md 缺要素：${missing.join("、")}`);
    }
  }

  if (failures.length > 0) {
    console.error("talkcraft 许可闸 FAIL：\n- " + failures.join("\n- "));
    process.exit(1);
  }
  console.log("talkcraft 许可闸 PASS：上游源码未入库；引擎许可/授权留痕口径一致");
}

main();
