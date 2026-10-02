/**
 * stress-im-gesture.ts —— U-01 回归：IM 手势回调批准后必须驱动线程自动续跑（B-05 第三路实弹）
 *
 * 背景：审计台账 U-01 记「IM 手势回调的批准后钩子仅 typecheck 级验证，mock 通道未实弹」，
 * 回归路径写的是「配置 IM_DRIVER 实通道 → 手势批准 → 断言线程自动续跑」。
 * 事实核查（本脚本落地时确认）：真实通道是**仓库外的 dsh 宿主插件**（`@xmanrui/dsh-im`，
 * 凭据在 dsh 设置页），本仓里 `IM_DRIVER` 只用于出站驱动选择；把「实通道」等同于本仓可自证
 * 是不成立的。本仓可自证的是**回调入口本身**：`im.callback` 的验签分支 + 手势消费 + 批准后钩子。
 *
 * 因此本脚本走真实 HTTP 入口 `/trpc/im.callback`，并**真实计算 HMAC 签名**（走 verified 分支，
 * 而不是"未配置 secret → 本人降级"那条宽松路径），断言：
 *   ① 合法签名 → 审批落 approved（unsigned=false）+ 线程自动离开 pending_review（第三路钩子生效）
 *   ② 签名错误 → 403（验签分支真实生效）
 *   ③ 时间戳超出 ±5 分钟重放窗口 → 403
 *
 * 前置：server 以 `IM_CHANNEL_SECRET_DINGTALK=<secret>` 启动（本脚本读同名环境变量；缺省即失败关闭）。
 * 用法：IM_CHANNEL_SECRET_DINGTALK=<secret> pnpm exec tsx --env-file=.env stress/stress-im-gesture.ts
 */
import { createHmac } from "node:crypto";
import pg from "pg";
import { BASE, check, login, ownerPool, scene, step, summary, RUN_ID } from "./_helper.js";

const SECRET = process.env.IM_CHANNEL_SECRET_DINGTALK ?? "";
const CHANNEL = "dingtalk" as const;
const OPENID = `stress-im-openid-${RUN_ID}`;
const SCOPE = { tenantId: "tenant-demo", workspaceId: "ws-yunqi" };

/** 与 packages/base/im-channels/callback.ts#stableStringify 同口径（对象键排序、数组保序） */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

function sign(payload: unknown, atMs = Date.now()): { ts: string; sig: string } {
  const ts = String(Math.floor(atMs / 1000));
  const body = stableStringify(payload);
  return { ts, sig: createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex") };
}

async function callGesture(payload: Record<string, unknown>, opts: { token: string; ts?: string; sig?: string }) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${opts.token}`,
  };
  if (opts.ts) headers["x-channel-timestamp"] = opts.ts;
  if (opts.sig) headers["x-channel-signature"] = opts.sig;
  const res = await fetch(`${BASE}/trpc/im.callback`, { method: "POST", headers, body: JSON.stringify(payload) });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body: body as { result?: { data?: { status?: string; unsigned?: boolean; deduped?: boolean } }; error?: { message?: string } } };
}

async function main(): Promise<void> {
  if (!SECRET) {
    console.error("❌ 需要 IM_CHANNEL_SECRET_DINGTALK（用签名分支实弹；缺省即失败关闭，不做未经签名的降级判定）");
    process.exit(2);
  }
  const db = ownerPool();
  const token = await login();
  step(`运行标识 ${RUN_ID}；演示身份登录成功；通道=${CHANNEL}（已配置 secret，走 verified 分支）`);

  /* ---------- 现场：成员 openid 绑定 + 线程挂起 + 步骤级 pending 审批 ---------- */
  scene("现场准备：成员绑定 → 线程 pending_review → 待办审批");
  await db.query(
    `UPDATE members SET im_openids = COALESCE(im_openids, '{}'::jsonb) || $3::jsonb
      WHERE workspace_id=$1 AND member_no=$2`,
    [SCOPE.workspaceId, "MEM-001", JSON.stringify({ [CHANNEL]: OPENID })],
  );
  const tid = `T-im-${RUN_ID}`;
  const aprId = `apr-im-${RUN_ID}`;
  await db.query(
    `INSERT INTO threads (id, tenant_id, workspace_id, title, mode, status, created_by, agent_id)
     VALUES ($1,$2,$3,'桌面助理执行一件小事','quest','pending_review','MEM-001',
             (SELECT id FROM agents WHERE workspace_id=$3 AND preset_key='desktop-agent'))`,
    [tid, SCOPE.tenantId, SCOPE.workspaceId],
  );
  /**
   * 事件用真实网关写入（保持哈希链与五元完整），再挂一条 pending 审批——模拟"步骤越围栏挂起"。
   * 事件写 `kind=review`：既不算"已完成步骤"（replay 不跳过），又能被 approvedStepIds 按
   * session_id + step_id 找到——于是批准后钩子一定会驱动该步骤续跑。
   */
  const gwPool = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
  const { gatewayAppend } = await import("@workloom/base/workdata");
  const ev = await gatewayAppend(gwPool, { ...SCOPE, actor: { id: "desktop-agent", type: "agent", fenceBindings: ["R2"] }, sessionId: tid }, {
    who: { type: "agent", id: "desktop-agent", version: "v1" },
    context: { tenant_id: SCOPE.tenantId, workspace_id: SCOPE.workspaceId, time: new Date().toISOString() },
    object: { type: "suite", id: `im-${RUN_ID}` },
    decision: { action: "desktop.gui", step_id: "s1", kind: "review", params: { clicks: 1 } },
    rule_impact: [],
  });
  await gwPool.end();
  await db.query(
    `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, snapshot)
     VALUES ($1,$2,$3,$4,'inapp','pending',$5)`,
    [aprId, SCOPE.tenantId, SCOPE.workspaceId, ev.eventId,
      JSON.stringify({ gate: true, step_id: "s1", high_risk: true, expires_at: new Date(Date.now() + 864e5).toISOString() })],
  );
  step(`现场就绪：线程 ${tid}（pending_review）+ 审批 ${aprId}（pending）+ 成员 openid 绑定 ${OPENID}`);

  const payload = {
    channel: CHANNEL,
    approvalId: aprId,
    operatorOpenId: OPENID,
    conversationId: `conv-${RUN_ID}`,
    gesture: "approve" as const,
  };

  /* ---------- ② 签名错误必须先被拒（证明验签分支真实生效） ---------- */
  scene("② 错误签名 → 403（验签分支真实生效，而非「未配置 secret」的宽松降级）");
  {
    const { ts } = sign(payload);
    const bad = await callGesture(payload, { token, ts, sig: "0".repeat(64) });
    check("② 错误 HMAC 签名必须被拒（403）", bad.status === 403, `实际 HTTP ${bad.status}：${bad.body?.error?.message ?? ""}`);
  }

  /* ---------- ③ 时间戳超出重放窗口必须被拒 ---------- */
  scene("③ 时间戳超出 ±5 分钟重放窗口 → 403");
  {
    const stale = Date.now() - 10 * 60_000;
    const { ts, sig } = sign(payload, stale);
    const r = await callGesture(payload, { token, ts, sig });
    check("③ 过期时间戳必须被拒（403）", r.status === 403, `实际 HTTP ${r.status}：${r.body?.error?.message ?? ""}`);
  }

  /* ---------- ① 合法签名 → 批准 + 线程自动续跑（第三路钩子实弹） ---------- */
  scene("① 合法签名 → 审批 approved（unsigned=false）→ 线程自动离开 pending_review");
  {
    const { ts, sig } = sign(payload);
    const r = await callGesture(payload, { token, ts, sig });
    step(`回调响应：HTTP ${r.status} status=${r.body?.result?.data?.status} unsigned=${r.body?.result?.data?.unsigned}`);
    check("①a 手势被接受且验签为真（unsigned=false）", r.status === 200 && r.body?.result?.data?.status === "approved" && r.body?.result?.data?.unsigned === false,
      `HTTP ${r.status} status=${r.body?.result?.data?.status} unsigned=${r.body?.result?.data?.unsigned}`);

    const apr = await db.query<{ status: string }>(`SELECT status FROM approvals WHERE approval_id=$1`, [aprId]);
    check("①b 审批落库 approved", apr.rows[0]?.status === "approved", `实际 ${apr.rows[0]?.status}`);

    // 批准后钩子是进程内异步续跑（fire-and-forget）：轮询等线程离开 pending_review
    let finalStatus = "pending_review";
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r2) => setTimeout(r2, 500));
      const row = await db.query<{ status: string }>(`SELECT status FROM threads WHERE id=$1`, [tid]);
      finalStatus = row.rows[0]?.status ?? "missing";
      if (finalStatus !== "pending_review") break;
    }
    check("①c IM 手势批准后线程必须自动续跑（离开 pending_review）", finalStatus !== "pending_review", `实际 ${finalStatus}`);
  }

  // 清理
  await db.query(`DELETE FROM approvals WHERE approval_id=$1`, [aprId]);
  await db.query(`DELETE FROM threads WHERE id=$1`, [tid]);
  await db.query(
    `UPDATE members SET im_openids = im_openids - $3 WHERE workspace_id=$1 AND member_no=$2`,
    [SCOPE.workspaceId, "MEM-001", CHANNEL],
  );
  await db.end();
  summary();
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
