/**
 * stress-approval.ts —— 审批链动态排雷（对应静态台账 B-01 / B-02 / B-05）
 * 前置：server 运行中；DATABASE_URL/DATABASE_GATEWAY_URL 可用。
 * 适用基线：e71f30c。用例自带清理（测试审批行用后删除）。
 * 断言口径：高危审批（snapshot 无 high_risk 的对外/花钱门）不得被批量照批；
 *          高危授权票据不得无限复用。
 */
import { check, login, ownerPool, gatewayPool, scene, step, summary, trpc, RUN_ID } from "./_helper.js";
import { gatewayAppend } from "@workloom/base/workdata";

const SCOPE = { tenantId: "tenant-demo", workspaceId: "ws-yunqi" };

async function main(): Promise<void> {
  const db = ownerPool();
  const token = await login();
  step(`运行标识 ${RUN_ID}；演示身份登录成功`);

  /* ---------- B-01 批量审批高危守卫空转（构造 G9 发布门式审批：snapshot 无 high_risk） ---------- */
  scene("B-01 批量审批高危守卫（snapshot 无 high_risk 的对外门不得批量照批）");
  const ids: string[] = [];
  for (const [i, tier] of ["l2_captain", "l4_chairman"].entries()) {
    const id = `apr-stress-b01-${RUN_ID}-${i}`;
    ids.push(id);
    await db.query(
      `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, snapshot, tier)
       VALUES ($1,$2,$3,$4,'inapp','pending',$5,$6)`,
      [id, SCOPE.tenantId, SCOPE.workspaceId, `E-STRESS-B01-${RUN_ID}-${i}`,
       JSON.stringify({ gate: "G9", title: `stress·对外发布门 ${tier}`, action: "publish.submit", params: { platform: "douyin" } }), tier],
    );
  }
  step("已构造 2 条 snapshot 无 high_risk 的对外发布门审批（l2/l4 各一）");
  try {
    const res = await trpc<{ approved: string[]; skipped: Array<{ approvalId: string; reason: string }> }>(
      "approvals.batchApprove", { token, method: "mutation", input: { approvalIds: ids } },
    );
    step(`batchApprove 返回：approved=${JSON.stringify(res.approved)} skipped=${JSON.stringify(res.skipped)}`);
    check("B-01a 无 high_risk 标记的对外门审批不得被批量照批（l2）",
      !res.approved.includes(ids[0]!), `approved 含 ${ids[0]} 即守卫空转`);
    check("B-01b 无 high_risk 标记的对外门审批不得被批量照批（l4）",
      !res.approved.includes(ids[1]!), `approved 含 ${ids[1]} 即守卫空转`);
  } catch (err) {
    step(`batchApprove 抛错：${err instanceof Error ? err.message : String(err)}（整体拒绝也视为有守卫）`);
    check("B-01a 无 high_risk 标记的对外门审批不得被批量照批（l2）", true, "接口整体拒绝");
    check("B-01b 无 high_risk 标记的对外门审批不得被批量照批（l4）", true, "接口整体拒绝");
  }
  const after = await db.query<{ approval_id: string; status: string }>(
    `SELECT approval_id, status FROM approvals WHERE approval_id = ANY($1)`, [ids]);
  for (const row of after.rows) step(`DB 现状：${row.approval_id} → ${row.status}`);

  /* ---------- B-02 高危授权票据复用（同一 approvalRef 两次写动作必须第二次被拒） ---------- */
  scene("B-02 高危 Agent 逐次授权票据不得复用（L3.5）");
  const refId = `apr-stress-b02-${RUN_ID}`;
  await db.query(
    `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, snapshot, tier)
     VALUES ($1,$2,$3,$4,'inapp','approved','{}','l4_chairman')`,
    [refId, SCOPE.tenantId, SCOPE.workspaceId, `E-STRESS-B02-${RUN_ID}`],
  );
  step(`已构造 approved 通用授权票据 ${refId}（snapshot={}，无绑定字段）`);
  const gw = gatewayPool();
  const draft = (n: number) => ({
    who: { type: "agent" as const, id: "desktop-agent", version: "stress" },
    context: { tenant_id: SCOPE.tenantId, workspace_id: SCOPE.workspaceId, time: new Date().toISOString() },
    object: { type: "stress_object", id: `obj-${RUN_ID}-${n}` },
    decision: { action: "price.adjust" },
    rule_impact: [],
  });
  const ctx = {
    tenantId: SCOPE.tenantId, workspaceId: SCOPE.workspaceId,
    actor: { id: "desktop-agent", type: "agent" as const, highRisk: true, fenceBindings: ["*"] },
    approvalRef: refId,
  };
  let first = false;
  let second = false;
  let secondErr = "";
  try { await gatewayAppend(gw, ctx, draft(1)); first = true; } catch { /* 第一次即被拒也说明有守卫 */ }
  try { await gatewayAppend(gw, ctx, draft(2)); second = true; } catch (err) { secondErr = err instanceof Error ? err.message : String(err); }
  step(`第一次写：${first ? "放行" : "拒绝"}；第二次写：${second ? "放行" : `拒绝（${secondErr.slice(0, 60)}）`}`);
  check("B-02 同一 approvalRef 第二次写动作必须被拒绝（一次性消费）", first && !second,
    second ? "票据被无限复用" : first ? "" : "第一次即被拒（更保守，可接受）");

  // 清理测试现场
  await db.query(`DELETE FROM approvals WHERE approval_id = ANY($1)`, [[...ids, refId]]);
  step("测试审批行已清理");
  await gw.end();
  await db.end();
  summary();
}

main().catch((err) => { console.error(err); process.exit(2); });
