#!/usr/bin/env node
/**
 * 开户即托管 CLI（《GROWTH 深度产品方案》§3）
 *
 *   pnpm onboarding provision --tenant tn-x --workspace ws-x --name "XX 获客用增" --slug xx-growth [--bundle geo-growth] [--by platform:ops]
 *   pnpm onboarding cycle      --tenant tn-x --workspace ws-x
 *   pnpm onboarding report     --tenant tn-x --workspace ws-x [--hours 24] [--name "XX 获客用增"]
 *   pnpm onboarding first-login --tenant tn-x --workspace ws-x
 *   pnpm onboarding advance    --tenant tn-x --workspace ws-x --by MEM-001 --confirm
 *
 * 说明：默认主包取 product.manifest.json#defaultBundle（获客用增）；全部动作幂等。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import {
  provisionShadowWorkspace, runShadowCycle, generateShadowReport,
  firstLoginPayload, advanceFromShadow,
} from "@workloom/base/captain";

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const has = (name: string) => process.argv.includes(name);

const ROOT = join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "product.manifest.json"), "utf8")) as { defaultBundle: string };
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:workloom@localhost:5432/workloom";
const app = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });

const scope = () => ({
  tenantId: arg("--tenant") ?? (() => { throw new Error("缺少 --tenant"); })(),
  workspaceId: arg("--workspace") ?? (() => { throw new Error("缺少 --workspace"); })(),
});

const command = process.argv[2];

async function main(): Promise<void> {
  if (command === "provision") {
    const s = scope();
    const result = await provisionShadowWorkspace(app, {
      tenantId: s.tenantId,
      tenantName: arg("--tenant-name", s.tenantId),
      workspaceId: s.workspaceId,
      workspaceName: arg("--name", s.workspaceId) ?? s.workspaceId,
      slug: arg("--slug", s.workspaceId) ?? s.workspaceId,
      primaryBundle: arg("--bundle", manifest.defaultBundle)!,
      by: arg("--by", "platform:onboarding")!,
      shadowDays: Number(arg("--shadow-days", "3")),
      trialDays: Number(arg("--trial-days", "7")),
    });
    console.log(`✓ 开户即托管：${result.workspaceId}（${result.bundleIds.join(" + ")}）`);
    console.log(`  编制 ${result.rosterSize} 岗 · 组合围栏 ${result.fenceRules} 条 · 同名遮蔽 ${result.shadowed} 处 · 宪章档位 ${result.charterMode}`);
    return;
  }
  if (command === "cycle") {
    const beats = await runShadowCycle(app, scope());
    console.log(`✓ 影子周期完成：简报 ${beats.briefing.eventId || "跳过"} · 队列裁决 ${beats.queue.decided} 件（上浮 ${beats.queue.escalated}）· 偏差立项 ${beats.deviation.initiatives} 件`);
    return;
  }
  if (command === "report") {
    const s = scope();
    const { report, eventId } = await generateShadowReport(app, s, {
      windowHours: Number(arg("--hours", "24")),
      workspaceName: arg("--name", s.workspaceId),
    });
    console.log(`✓ 影子对照报告已落账 ${eventId}（${report.totals.decisions} 件 dry_run 决策）`);
    console.log(report.text);
    return;
  }
  if (command === "first-login") {
    const payload = await firstLoginPayload(app, scope());
    if (!payload.shadowReport) throw new Error("首登载荷缺少影子报告：先跑 cycle + report");
    console.log(payload.shadowReport.text);
    if (payload.briefing) console.log(`\n—— 最新简报 ——\n${payload.briefing.text}`);
    return;
  }
  if (command === "advance") {
    const s = scope();
    const charter = await advanceFromShadow(app, s, {
      by: arg("--by", "MEM-001")!,
      confirmed: has("--confirm"),
    });
    console.log(`✓ 客户转正：shadow → ${charter.mode}（试用至 ${charter.grant?.trial_ends_at ?? "—"}；到期自动降级，不自动转正式）`);
    return;
  }
  console.error("用法：onboarding <provision|cycle|report|first-login|advance> --tenant <id> --workspace <id> [...]");
  process.exit(2);
}

main()
  .then(() => app.end())
  .catch(async (error) => {
    await app.end().catch(() => undefined);
    console.error(`开户即托管命令失败：${error?.message ?? error}`);
    process.exit(1);
  });
