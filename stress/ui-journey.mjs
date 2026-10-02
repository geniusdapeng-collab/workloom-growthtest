/**
 * ui-journey.mjs —— 独立验收 UI 实拍：客户核心旅程（登录 → 工作台 → AI 对话框派遣 → 审批中心）
 * 用法：node stress/ui-journey.mjs ；产物：/tmp/acc-shots/*.png
 */
import { chromium } from "../node_modules/.pnpm/playwright@1.63.0/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";

const OUT = "/tmp/acc-shots";
mkdirSync(OUT, { recursive: true });
const BASE = process.env.WEB_URL ?? "http://localhost:5173";

const browser = await chromium.launch({
  headless: true,
  executablePath: "/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const shots = [];
async function shot(name) {
  const p = `${OUT}/${name}.png`;
  await page.screenshot({ path: p, fullPage: false });
  shots.push(p);
  console.log(`📸 ${name} → ${p}`);
}

try {
  await page.goto(BASE, { waitUntil: "networkidle", timeout: 30_000 });
  await shot("01-entry");

  // 跳过开场进入工作台
  try {
    const skip = page.locator("text=跳过开场").first();
    if (await skip.isVisible({ timeout: 3_000 })) await skip.click();
  } catch { /* 已在工作台 */ }
  await page.waitForTimeout(3_000);
  await shot("02-workbench");

  // AI 对话框派遣一条任务（右下织伴输入框：placeholder「问一句、派个任务，或留言…」）
  try {
    const input = page.locator("textarea[placeholder*='问一句'], textarea[placeholder*='派个任务'], input[placeholder*='问一句']").first();
    await input.click({ timeout: 6_000 });
    await input.fill("帮我整理一份今日运营简报");
    await page.locator("button:has-text('发送')").first().click();
    await page.waitForTimeout(10_000);
    await shot("03-dispatch");
  } catch (err) {
    console.log("对话框交互失败（记录为实拍缺口）:", String(err).slice(0, 120));
  }

  // 审批中心/组合看板等关键页面探测
  for (const [name, pattern] of [["04-approvals", /审批|请示|决断/], ["05-portfolio", /组合|看板|任务/]]) {
    try {
      const nav = page.getByRole("link", { name: pattern }).first();
      const navBtn = page.getByRole("button", { name: pattern }).first();
      if (await nav.isVisible({ timeout: 2_000 })) await nav.click();
      else if (await navBtn.isVisible({ timeout: 2_000 })) await navBtn.click();
      await page.waitForTimeout(2_500);
      await shot(name);
    } catch {
      console.log(`${name} 导航未找到（实拍缺口）`);
    }
  }
} finally {
  await browser.close();
}
console.log(`完成 ${shots.length} 张实拍`);
