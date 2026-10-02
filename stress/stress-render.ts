/**
 * stress-render.ts —— 渲染/交付链动态排雷（对应静态台账 C-01 / C-02 / C-03 / C-04）
 * 前置：DATABASE_URL/DATABASE_GATEWAY_URL 可用；无需 server（函数级直击）。
 * 适用基线：e71f30c。唯一后缀 RUN_ID 保证可复跑；测试 job/事件行用后清理（biz_events 只增不改，测试事件以 STRESS 前缀留档）。
 */
import { check, login, trpc, ownerPool, gatewayPool, scene, step, summary, RUN_ID } from "./_helper.js";
import { pollRenderJobs } from "../apps/server/src/video/render-poller.js";

const SCOPE = { tenantId: "tenant-demo", workspaceId: "ws-yunqi" };

async function main(): Promise<void> {
  const db = ownerPool();
  const gw = gatewayPool();
  step(`运行标识 ${RUN_ID}`);

  /* ---------- C-01 mock 渲染完成事件不得携带 synced:true 假回执 ---------- */
  scene("C-01 mock 渲染完成回执必须标注（synced=false / mock）");
  const projId = `proj-stress-${RUN_ID}`;
  await db.query(
    `INSERT INTO video_projects (id, workspace_id, title, kind, created_by) VALUES ($1,$2,$3,'narrative','stress')`,
    [projId, SCOPE.workspaceId, `stress·项目 ${RUN_ID}`],
  );
  const scrId = `scr-stress-${RUN_ID}`;
  await db.query(
    `INSERT INTO render_scripts (id, workspace_id, project_id, shot_id, script_key, md, created_by)
     VALUES ($1,$2,$3,$4,$5,'# stress','stress')`,
    [scrId, SCOPE.workspaceId, projId, `shot-stress-${RUN_ID}`, `key-stress-${RUN_ID}`],
  );
  const jobId = `rj-stress-${RUN_ID}`;
  await db.query(
    `INSERT INTO render_jobs (id, workspace_id, project_id, script_id, script_version, task_id, status, provider)
     VALUES ($1,$2,$3,$4,1,$5,'submitted','seedance')`,
    [jobId, SCOPE.workspaceId, projId, scrId, `mock-stress-${RUN_ID}`],
  );
  step(`已造 mock 渲染任务 ${jobId}（task_id 前缀 mock-）`);
  const report = await pollRenderJobs(db as never, gw as never, SCOPE, { ingest: false, archive: null, limit: 5 });
  step(`poll 结果：checked=${report.checked} done=${report.done} failed=${report.failed} running=${report.running}；detail=${JSON.stringify(report.details.find((d) => d.jobId === jobId) ?? null)}`);
  const ev = await db.query<{ receipt: unknown; after: unknown }>(
    `SELECT payload->'receipt' AS receipt, payload->'decision'->'after' AS after
       FROM biz_events
      WHERE payload->'decision'->>'action' = 'render.complete'
        AND payload->'decision'->'after'->>'task_id' = $1
      ORDER BY seq DESC LIMIT 1`,
    [`mock-stress-${RUN_ID}`]);
  if (ev.rows[0]) {
    const receipt = ev.rows[0].receipt as { synced?: boolean; mode?: string } | null;
    const after = ev.rows[0].after as { mock?: boolean } | null;
    step(`render.complete 事件 receipt=${JSON.stringify(receipt)} after.mock=${after?.mock}`);
    check("C-01a mock 完成回执 synced 必须为 false", receipt?.synced === false, `实际 synced=${receipt?.synced}`);
    check("C-01b mock 完成事件必须可辨识（after.mock===true）", after?.mock === true, `实际 ${after?.mock}`);
  } else {
    check("C-01a mock 完成回执 synced 必须为 false", false, "未找到 render.complete 事件（poll 未推进？）");
    check("C-01b mock 完成事件必须可辨识", false, "未找到事件");
  }
  await db.query(`DELETE FROM render_jobs WHERE id=$1`, [jobId]);

  /* ---------- C-04 渲染作业 poll 持续异常不得永远悬停（终态超时判死） ---------- */
  scene("C-04 渲染作业须有终态出口（poll 持续异常 → failed）");
  const jobId2 = `rj-stress2-${RUN_ID}`;
  await db.query(
    `INSERT INTO render_jobs (id, workspace_id, project_id, script_id, script_version, task_id, status, provider, created_at)
     VALUES ($1,$2,$3,$4,1,$5,'submitted','seedance', now() - interval '48 hours')`,
    [jobId2, SCOPE.workspaceId, projId, scrId, `task-stuck-${RUN_ID}`],
  );
  step("已造 48h 前提交的僵尸任务；注入恒抛错 provider 连续 poll 3 轮");
  const throwingPool = new Map([
    ["seedance", {
      id: "seedance",
      submit: async () => { throw new Error("unused"); },
      poll: async () => { throw new Error("injected provider 5xx"); },
    }],
  ]);
  let det2: unknown = null;
  for (let round = 0; round < 3; round++) {
    const r = await pollRenderJobs(db as never, gw as never, SCOPE,
      { ingest: false, archive: null, limit: 5, pool: throwingPool as never });
    det2 = r.details.find((d) => d.jobId === jobId2) ?? det2;
  }
  const st2 = await db.query<{ status: string }>(`SELECT status FROM render_jobs WHERE id=$1`, [jobId2]);
  step(`3 轮 poll 后状态=${st2.rows[0]?.status}；detail=${JSON.stringify(det2 ?? null)}`);
  check("C-04 持续 poll 异常 + 超龄任务应被判 failed（有终态出口）", st2.rows[0]?.status === "failed",
    `实际 ${st2.rows[0]?.status}（永远悬停）`);
  await db.query(`DELETE FROM render_jobs WHERE id=$1`, [jobId2]);
  await db.query(`DELETE FROM render_scripts WHERE id=$1`, [scrId]);
  await db.query(`DELETE FROM video_projects WHERE id=$1`, [projId]);

  /* ---------- C-03 G9 发布挂起 → 审批单可见 → 批准 → 回迁执行（真实场景全链路） ---------- */
  scene("C-03 发布任务 pending_review 全回路（挂起有审批单 / 批准回迁 pending）");
  const { runPublishTask } = await import("../packages/base/publish-rpa/runner.js");
  const taskId = `pt-stress-${RUN_ID}`;
  await db.query(
    `INSERT INTO publish_tasks (id, workspace_id, platform, account_id, video_path, caption, status, created_by)
     VALUES ($1,$2,'douyin','stress-acct','/tmp/stress.mp4','stress 发布','pending','stress')`,
    [taskId, SCOPE.workspaceId],
  );
  const held = await runPublishTask(db as never, gw as never, SCOPE, taskId, {
    adapters: {},
    driver: {} as never, // 挂起路径在 driver 之前，不会触达
    fencePrecheck: () => ({ level: "review", triggeredBy: ["stress-g9-review"], impacts: [] }),
  } as never);
  step(`runner 挂起结果：kind=${held.kind}`);
  const st1 = await db.query<{ status: string }>(`SELECT status FROM publish_tasks WHERE id=$1`, [taskId]);
  const ap1 = await db.query<{ approval_id: string; status: string; snapshot: { high_risk?: boolean } }>(
    `SELECT approval_id, status, snapshot FROM approvals WHERE approval_id=$1`, [`apr-pub-${taskId}`]);
  check("C-03a 挂起任务为 pending_review 且审批中心有对应 pending 审批单",
    st1.rows[0]?.status === "pending_review" && ap1.rows[0]?.status === "pending",
    `任务=${st1.rows[0]?.status} 审批=${ap1.rows[0]?.status ?? "不存在"}`);
  check("C-03b 挂起审批单携带 high_risk 标记（不可批量照批）", ap1.rows[0]?.snapshot?.high_risk === true,
    `high_risk=${ap1.rows[0]?.snapshot?.high_risk}`);
  if (ap1.rows[0]) {
    const token = await login();
    await trpc("approvals.decide", { token, method: "mutation", input: { approvalId: ap1.rows[0].approval_id, gesture: "approve" } });
    const st2 = await db.query<{ status: string }>(`SELECT status FROM publish_tasks WHERE id=$1`, [taskId]);
    check("C-03c 审批通过后任务迁回 pending（可被重新领取执行）", st2.rows[0]?.status === "pending",
      `实际 ${st2.rows[0]?.status}`);
  }
  await db.query(`DELETE FROM approvals WHERE approval_id=$1`, [`apr-pub-${taskId}`]);
  await db.query(`DELETE FROM publish_tasks WHERE id=$1`, [taskId]);

  await gw.end();
  await db.end();
  summary();
}

main().catch((err) => { console.error(err); process.exit(2); });
