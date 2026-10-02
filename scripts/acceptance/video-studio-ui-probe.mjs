#!/usr/bin/env node
/**
 * 生成工作室 UI 探针（T-2026-0921-0002）
 *
 * 用法：node scripts/acceptance/video-studio-ui-probe.mjs [--base http://127.0.0.1:5173]
 *                                                    [--api http://127.0.0.1:8787]
 *                                                    [--job RJ-xxxx] [--out artifacts/video-studio]
 *
 * 前置：server（8787）与 web dev/preview（5173）已起。探针自行完成演示登录并把令牌注入
 *      localStorage（与 apps/web/src/lib/trpc.ts 同键），然后：
 *        ① 打开 /ai-video/studio —— 断言标题/模型下拉/报价/提交按钮渲染；
 *        ② 点击「立即刷新任务状态」—— 断言真实任务出现在队列（含已入库标记）；
 *        ③ 打开 /ai-video/assets —— 断言「打开生成工作室」入口在；
 *        ④ 截图落盘（人可复核）。
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(REPO_ROOT, "package.json"));
const { chromium } = require(join(REPO_ROOT, "node_modules", ".pnpm", "playwright@1.63.0", "node_modules", "playwright"));

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const BASE = arg("--base", "http://127.0.0.1:5173");
const API = arg("--api", "http://127.0.0.1:8787");
const EXPECT_JOB = arg("--job", "");
const OUT_DIR = resolve(arg("--out", join(REPO_ROOT, "artifacts", "video-studio")));
const TOKEN_KEY = "workloom:workloom-ai-growth:b-pc:access-token";

const login = await fetch(`${API}/trpc/auth.loginAs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ workspaceSlug: "geo-growth", memberNo: "MEM-G01" }),
}).then((r) => r.json());
const token = login?.result?.data?.token;
if (!token) {
  console.error("演示登录失败：", JSON.stringify(login).slice(0, 300));
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [TOKEN_KEY, token]);
const page = await context.newPage();
const failures = [];

async function shot(name) {
  const file = join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`📸 ${file}`);
  return file;
}

/* ① 工作室页 */
const PROJECT = arg("--project", "proj-prodtest");
await page.goto(`${BASE}/ai-video/assets?tab=studio&project=${encodeURIComponent(PROJECT)}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("text=生成工作室", { timeout: 20_000 });
await page.waitForTimeout(1500);
const title = await page.locator("text=生成工作室").first().innerText();
const modelOptions = await page.locator("select").first().locator("option").allInnerTexts();
const hasSubmit = await page.locator("button", { hasText: "提交生成" }).count();
const bodyText = await page.locator("body").innerText();
if (!title.includes("生成工作室")) failures.push("标题缺失");
if (modelOptions.length === 0) failures.push("模型下拉为空");
if (hasSubmit === 0) failures.push("提交按钮缺失");
if (!/预估成本/.test(bodyText)) failures.push("报价区缺失");
console.log(`① 工作室：模型 ${modelOptions.length} 个 → ${modelOptions.slice(0, 3).join(" | ")}`);
await shot("01-studio");

/* ② 点击刷新任务状态（真实轮询 + 入库回填） */
await page.locator("button", { hasText: "立即刷新任务状态" }).click();
await page.waitForTimeout(4000);
const afterPoll = await page.locator("body").innerText();
if (!/轮询完成|失败/.test(afterPoll)) failures.push("轮询无反馈");
if (EXPECT_JOB && !afterPoll.includes(EXPECT_JOB)) failures.push(`任务 ${EXPECT_JOB} 未出现在队列`);
if (EXPECT_JOB && !/已入库（自有媒体库）/.test(afterPoll)) failures.push("成片未显示「已入库」");
const videoCount = await page.locator("video").count();
console.log(`② 队列：任务卡渲染完成 · 播放器 ${videoCount} 个`);
await shot("02-studio-after-poll");

/* ③ 片库入口 */
await page.goto(`${BASE}/ai-video/assets`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
const assetsText = await page.locator("body").innerText();
if (!assetsText.includes("打开生成工作室")) failures.push("片库缺少工作室入口");
console.log("③ 片库：生成工作室入口存在");
await shot("03-assets-entry");

await browser.close();

const report = { base: BASE, api: API, expectedJob: EXPECT_JOB || null, modelOptions: modelOptions.length, videoCount, failures };
writeFileSync(join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
if (failures.length > 0) {
  console.error("❌ UI 探针失败：", failures.join("；"));
  process.exit(1);
}
console.log("✅ UI 探针通过：", JSON.stringify(report));
