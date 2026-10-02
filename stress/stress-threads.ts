/**
 * stress-threads.ts —— 任务派遣链动态排雷（对应静态台账 A-02 / A-03 / A-07 + 边界注入 + 越权）
 * 前置：server 运行中（scheduler 每 7000ms 扫描 queued 线程）。
 * 适用基线：e71f30c。唯一后缀 RUN_ID 保证可复跑。
 */
import { check, login, ownerPool, scene, step, summary, trpc, RUN_ID } from "./_helper.js";

const SCOPE = { tenantId: "tenant-demo", workspaceId: "ws-yunqi" };

async function main(): Promise<void> {
  const db = ownerPool();
  const token = await login();
  step(`运行标识 ${RUN_ID}`);

  /* ---------- A-02 ask 线程被调度器当 quest 执行（模拟 runAsk 进行中的 queued ask 线程） ---------- */
  scene("A-02 调度器不得把 ask 问询线程当 Quest 执行");
  const askId = `T-ASK-${RUN_ID}`;
  await db.query(
    `INSERT INTO threads (id, tenant_id, workspace_id, title, status, mode, created_by)
     VALUES ($1,$2,$3,$4,'queued','ask','stress')`,
    [askId, SCOPE.tenantId, SCOPE.workspaceId, `stress·问询线程 ${RUN_ID}`],
  ).catch(async (err) => {
    // 列名兜底：老 schema 可能无 tenant_id/mode/created_by 中的某些列
    step(`完整列插入失败（${String(err).slice(0, 80)}），尝试最小列`);
    await db.query(
      `INSERT INTO threads (id, workspace_id, title, status, mode) VALUES ($1,$2,$3,'queued','ask')`,
      [askId, SCOPE.workspaceId, `stress·问询线程 ${RUN_ID}`],
    );
  });
  step(`已造 queued/mode=ask 线程 ${askId}（模拟 runAsk 执行中状态），等待调度器两轮扫描（16s）…`);
  await new Promise((r) => setTimeout(r, 16_000));
  const th = await db.query<{ status: string; mode: string }>(`SELECT status, mode FROM threads WHERE id=$1`, [askId]);
  const ev = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM biz_events
      WHERE payload->'object'->>'id' = $1
        AND payload->'decision'->>'action' IN ('quest.plan','quest.step.execute','tool.execute','thread.dispatch','quest.step')`,
    [askId]);
  const evAny = await db.query<{ n: string; actions: string }>(
    `SELECT count(*)::text AS n, coalesce(string_agg(DISTINCT payload->'decision'->>'action', ','),'') AS actions
       FROM biz_events WHERE payload->'object'->>'id' = $1`, [askId]);
  step(`现状：status=${th.rows[0]?.status} mode=${th.rows[0]?.mode} quest类事件=${ev.rows[0]?.n} 全部事件=${evAny.rows[0]?.n}（${evAny.rows[0]?.actions || "无"}）`);
  check("A-02a ask 线程不得被调度器迁移出 queued 去执行", th.rows[0]?.status === "queued", `实际 ${th.rows[0]?.status}`);
  check("A-02b ask 线程不得产生 quest 规划/执行事件", ev.rows[0]?.n === "0", `实际 ${ev.rows[0]?.n} 条`);
  await db.query(`DELETE FROM threads WHERE id=$1`, [askId]);

  /* ---------- A-03/A-07 并发派遣 12 路：全部成功 + 线程号唯一 ---------- */
  scene("A-03/A-07 12 路并发派遣（号源唯一性 / 无重入）");
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, (_, i) =>
      trpc<{ kind?: string; threadId?: string }>("threads.dispatch", {
        token, method: "mutation",
        input: { title: `stress·并发派遣 ${RUN_ID}-${i}：整理一条今日运营简报`, runImmediately: false },
      }),
    ),
  );
  const okIds = results
    .map((r) => (r.status === "fulfilled" ? (r.value.threadId ?? null) : null))
    .filter((x): x is string => typeof x === "string");
  const failedN = results.length - okIds.length;
  step(`成功 ${okIds.length}/12，失败 ${failedN}（${results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason).slice(0, 60)).join(" | ") || "无"}）`);
  check("A-07 12 路并发派遣全部成功", failedN === 0, `失败 ${failedN}`);
  if (okIds.length) {
    const dup = await db.query<{ id: string; n: string }>(
      `SELECT id, count(*)::text AS n FROM threads WHERE id = ANY($1) GROUP BY id HAVING count(*) > 1`, [okIds]);
    const missing = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM threads WHERE id = ANY($1)`, [okIds]);
    check("A-07b 派遣线程全部落库且无撞号", dup.rows.length === 0 && missing.rows[0]?.n === String(okIds.length),
      `落库 ${missing.rows[0]?.n}/${okIds.length}`);
  }

  /* ---------- 边界值：注入式 / 空参 / 超长 ---------- */
  scene("边界值（注入式输入 / 空标题 / 超长标题）");
  const inj = await trpc<{ threadId?: string; kind?: string }>("threads.dispatch", {
    token, method: "mutation",
    input: { title: `'); DROP TABLE threads;-- ${RUN_ID}`, runImmediately: false },
  }).catch((err) => ({ error: String(err) }));
  const alive = await db.query(`SELECT 1 FROM threads LIMIT 1`).then(() => true).catch(() => false);
  check("INJ-1 注入式标题不造成破坏且服务存活", alive, `响应 ${JSON.stringify(inj).slice(0, 60)}`);
  const empty = await trpc("threads.dispatch", { token, method: "mutation", input: { title: "", runImmediately: false } })
    .then(() => "accepted").catch((err) => (err as Error).name === "TrpcError" ? "rejected" : "error");
  check("INJ-2 空标题被参数校验拒绝", empty === "rejected", `实际 ${empty}`);
  const longTitle = "长".repeat(600);
  const long = await trpc("threads.dispatch", { token, method: "mutation", input: { title: longTitle, runImmediately: false } })
    .then(() => "accepted").catch(() => "rejected");
  check("INJ-3 超长标题（600>500）被明确拒绝或安全截断", long === "rejected", `实际 ${long}`);

  /* ---------- 越权：租户/工作区 B 凭据读工作区 A 数据 ---------- */
  scene("越权（geo 工作区凭据访问 yunqi 线程数据，应返回空/拒绝而非泄露）");
  const geoToken = await login("geo-growth", "MEM-GEO1").catch(async () => {
    // 找 geo 工作区任一成员
    const m = await db.query<{ member_no: string }>(
      `SELECT member_no FROM members WHERE workspace_id='ws-geo' LIMIT 1`).catch(() => ({ rows: [] }));
    if (m.rows[0]) return login("geo-growth", m.rows[0].member_no);
    throw new Error("geo 工作区无可用成员");
  });
  const yunqiThread = await db.query<{ id: string }>(
    `SELECT id FROM threads WHERE workspace_id='ws-yunqi' LIMIT 1`);
  if (yunqiThread.rows[0]) {
    const tid = yunqiThread.rows[0].id;
    const cross = await trpc<unknown>("threads.events", { token: geoToken, input: { threadId: tid } })
      .then((r) => ({ ok: true as const, data: r }))
      .catch((err) => ({ ok: false as const, err: String(err).slice(0, 80) }));
    if (cross.ok) {
      const n = Array.isArray(cross.data) ? cross.data.length : -1;
      check("SEC-1 跨工作区读取 threads.events 应拒绝或返回空", n === 0, `泄露 ${n} 条事件`);
    } else {
      check("SEC-1 跨工作区读取 threads.events 应拒绝或返回空", true, cross.err);
    }
    const crossList = await trpc<Array<{ id: string }>>("threads.list", { token: geoToken });
    const leak = crossList.some((t) => t.id === tid);
    check("SEC-2 跨工作区 threads.list 不得混入他区线程", !leak, `列表 ${crossList.length} 条，泄漏=${leak}`);
  } else {
    step("ws-yunqi 无线程可测，跳过 SEC-1/2");
  }

  await db.end();
  summary();
}

main().catch((err) => { console.error(err); process.exit(2); });
