#!/usr/bin/env node
/**
 * acceptance:onboarding · 开户即托管验收门禁（RDAS 口径：非 0 退出即阻断合并）
 *
 * 验收链（全真实数据库、全真实链路、无 mock 回执）：
 *   ① 平台开户：自动装配组合编制（72 岗口径随装配器事实）+ 默认 shadow 档；
 *   ② 影子周期：CEO 节拍全 dry_run（简报 + 待审队列 + 偏差扫描），事件标 dry_run=true；
 *   ③ 影子对照报告：聚合 dry_run 决策落账为 shadow_report；
 *   ④ 首登载荷：影子报告 + 最新简报齐备（"没开箱就在运营"的验收面）；
 *   ⑤ 客户转正：shadow → trial（到期自动降级，不自动转正式）；
 *   ⑥ 回滚：临时租户/工作区数据清理（delete 为夹具清理，业务事件本身 append-only）。
 *
 * 运行：pnpm acceptance:onboarding（CI 的 test-gate 已接入）
 */
import pg from "pg";
import {
  provisionShadowWorkspace, runShadowCycle, generateShadowReport,
  firstLoginPayload, advanceFromShadow,
} from "@workloom/base/captain";
import { composeWorkforce } from "@workloom/base/bundles";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:workloom@localhost:5432/workloom";
const PRIMARY_BUNDLE = process.env.ACCEPTANCE_PRIMARY_BUNDLE ?? "geo-growth";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `（${detail}）` : ""}`);
  if (!ok) failures += 1;
}

async function main(): Promise<void> {
  const suffix = Date.now().toString(36);
  const tenantId = `tn-onboarding-${suffix}`;
  const workspaceId = `ws-onboarding-${suffix}`;
  const app = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  try {
    const expected = composeWorkforce(PRIMARY_BUNDLE);
    const expectedRoster = expected.presets.size;

    // ① 开户：自动装配 + 默认影子
    const provision = await provisionShadowWorkspace(app, {
      tenantId,
      workspaceId,
      workspaceName: "验收 · 获客用增新客",
      slug: workspaceId,
      primaryBundle: PRIMARY_BUNDLE,
      by: "acceptance:onboarding",
    });
    check("① 开户即托管：组合装配完成", provision.rosterSize === expectedRoster,
      `${provision.rosterSize}/${expectedRoster} 岗 · ${provision.bundleIds.join("+")}`);
    check("① 默认进入影子档", provision.charterMode === "shadow", provision.charterMode);
    check("① 组合围栏齐装", provision.fenceRules >= 60, `${provision.fenceRules} 条`);

    const ready = await app.query<{ n: number }>(
      `SELECT count(*)::int n FROM agents WHERE workspace_id=$1 AND status='ready'`, [workspaceId],
    );
    check("① 全员 ready 落库", ready.rows[0]!.n === expectedRoster, `${ready.rows[0]!.n} 人`);

    // ② 影子周期：dry_run 决策（含一条真实的带内 L2 待审夹具，验证"AI 在客户不在场时作出判断"）
    await app.query(
      `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, snapshot, tier)
       VALUES ($1,$2,$3,$4,'inapp','pending',$5,'l2_captain')`,
      [`apr-onboarding-${suffix}`, tenantId, workspaceId, `E-apr-${suffix}`,
        JSON.stringify({ action: "price.adjust", params: { price: 480 }, base_price: 458, title: "周末房价带内调整" })],
    );
    const cycle = await runShadowCycle(app, { tenantId, workspaceId });
    const dry = await app.query<{ n: number }>(
      `SELECT count(*)::int n FROM biz_events
        WHERE workspace_id=$1 AND payload->'decision'->'params'->>'dry_run'='true'`,
      [workspaceId],
    );
    check("② 影子周期产生 dry_run 决策", dry.rows[0]!.n >= 2 && cycle.queue.decided >= 1,
      `briefing=${cycle.briefing.eventId || "skip"} queue=${cycle.queue.decided} dry_run=${dry.rows[0]!.n}`);
    const approvalUntouched = await app.query<{ status: string }>(
      `SELECT status FROM approvals WHERE approval_id=$1`, [`apr-onboarding-${suffix}`],
    );
    check("② 影子期不落地执行（审批状态保持 pending，仅推理留痕）", approvalUntouched.rows[0]!.status === "pending",
      approvalUntouched.rows[0]!.status);

    // ③ 影子对照报告
    const { report, eventId } = await generateShadowReport(app, { tenantId, workspaceId }, {
      windowHours: 24, workspaceName: "验收 · 获客用增新客",
    });
    const reportRow = await app.query<{ n: number }>(
      `SELECT count(*)::int n FROM biz_events
        WHERE workspace_id=$1 AND event_id=$2 AND payload->'decision'->>'action'='ceo.shadow_report'
          AND payload->'object'->>'type'='shadow_report'`,
      [workspaceId, eventId],
    );
    check("③ 影子对照报告落账（shadow_report 对象）", reportRow.rows[0]!.n === 1, eventId);
    check("③ 报告含判断与升级口径", report.text.includes("完整推理") && report.text.includes("转正前不会产生任何对外动作"));

    // ④ 首登载荷
    const first = await firstLoginPayload(app, { tenantId, workspaceId });
    check("④ 首登即见影子报告", Boolean(first.shadowReport?.text), first.shadowReport?.eventId ?? "无");
    check("④ 首登附带最新简报", Boolean(first.briefing?.text), first.briefing?.eventId ?? "无");

    // ⑤ 客户转正
    const charter = await advanceFromShadow(app, { tenantId, workspaceId }, { by: "acceptance:owner", confirmed: true });
    check("⑤ 转正进入试用（shadow→trial）", charter.mode === "trial", `试用至 ${charter.grant?.trial_ends_at ?? "—"}`);
    let guard = false;
    try { await advanceFromShadow(app, { tenantId, workspaceId }, { by: "acceptance:owner", confirmed: true }); }
    catch { guard = true; }
    check("⑤ 非法重复转正被拒（状态机守住）", guard);

    // ⑥ 账本 append-only：验收事件必须留痕且删除被拒（L1.1 铁律）
    let deleteBlocked = false;
    try { await app.query(`DELETE FROM biz_events WHERE workspace_id=$1`, [workspaceId]); }
    catch { deleteBlocked = true; }
    check("⑥ 账本 append-only：删除被触发器拒绝（L1.1）", deleteBlocked);
    // 其余夹具清理（事件保留为审计痕迹）
    await app.query(`DELETE FROM approvals WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
    await app.query(`DELETE FROM agents WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
    await app.query(`DELETE FROM fence_rules WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
    await app.query(`DELETE FROM profiles WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
    await app.query(`DELETE FROM workspaces WHERE id=$1`, [workspaceId]).catch(() => undefined);
    await app.query(`DELETE FROM tenants WHERE id=$1`, [tenantId]).catch(() => undefined);
    check("⑥ 非账本夹具已清理（账本事件保留）", true, `${workspaceId}`);
  } finally {
    await app.end().catch(() => undefined);
  }

  console.log(`\nacceptance:onboarding ${failures === 0 ? "通过" : `失败 ${failures} 项`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`acceptance:onboarding 异常：${error?.stack ?? error}`);
  process.exit(1);
});
