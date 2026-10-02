/**
 * geo-growth × ask 领域事实面（GR-19 / N-09）。
 *
 * 背景：`registerAskFactProvider` 此前全仓零调用点——获客工作区问"本周线索/内容/能见度怎么样"，
 * facts 里只有底座通用面（事件条数/审批数/线程数），模型只能答"没有相关记录"。
 *
 * 口径（与 defaultAskFactProvider 完全一致）：
 *  - **全部实时查询**（biz_events 投影 + account_metrics/content_calendar 表），不缓存、不猜数；
 *  - 数字来源写进 sources，答案可下钻溯源；
 *  - 查询失败/无数据 → 不编造（facts 为空由调用方按"数据不足"处理）。
 */
import type pg from "pg";

interface Scope { tenantId: string; workspaceId: string }
export interface AskFact { label: string; value: string }
export interface AskFactResult { facts: AskFact[]; sources: string[] }
export type AskFactProvider = (app: pg.Pool, scope: Scope, question: string) => Promise<AskFactResult>;

/** 事务级 RLS 上下文内跑一条聚合查询 */
async function scopedQuery<T extends Record<string, unknown>>(
  app: pg.Pool, scope: Scope, sql: string, params: unknown[] = [],
): Promise<T[]> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const r = await client.query<T>(sql, params);
    await client.query("COMMIT");
    return r.rows;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** 领域动作的近窗计数（事件账本投影） */
async function countActions(
  app: pg.Pool, scope: Scope, actions: string[], days: number,
): Promise<number> {
  const rows = await scopedQuery<{ n: string }>(app, scope,
    `SELECT count(*)::text AS n FROM biz_events
      WHERE workspace_id=$1 AND payload->'decision'->>'action' = ANY($2::text[])
        AND created_at > now() - ($3::text || ' days')::interval`,
    [scope.workspaceId, actions, String(days)]);
  return Number(rows[0]?.n ?? 0);
}

/** 内容与分发：内容生产 / 发布 / 改写 的实时计数 */
async function contentFacts(app: pg.Pool, scope: Scope): Promise<{ facts: AskFact[]; sources: string[] }> {
  const [published7, published30, rewritten7, calendarRows] = await Promise.all([
    countActions(app, scope, ["geo.publish", "publish.execute"], 7),
    countActions(app, scope, ["geo.publish", "publish.execute"], 30),
    countActions(app, scope, ["geo.rewrite"], 7),
    scopedQuery<{ n: string }>(app, scope,
      `SELECT count(*)::text AS n FROM content_calendar WHERE workspace_id=$1 AND slot_at > now()`, [scope.workspaceId]),
  ]);
  return {
    facts: [
      { label: "近 7 天内容发布", value: `${published7} 次（近 30 天 ${published30} 次）` },
      { label: "近 7 天内容改写", value: `${rewritten7} 次` },
      // 值文案只放业务口径，表名/字段名留在 sources（客户端展示边界会拦机器标识）
      { label: "内容排期待执行", value: `${Number(calendarRows[0]?.n ?? 0)} 条` },
    ],
    sources: ["biz_events（geo.publish/publish.execute/geo.rewrite）", "content_calendar"],
  };
}

/** 情报与实体：情报卡 / 实体巡检 */
async function intelFacts(app: pg.Pool, scope: Scope): Promise<{ facts: AskFact[]; sources: string[] }> {
  const [intel7, entity7] = await Promise.all([
    countActions(app, scope, ["intel_card.emit"], 7),
    countActions(app, scope, ["entity.scan"], 7),
  ]);
  return {
    facts: [
      { label: "近 7 天情报卡", value: `${intel7} 张` },
      { label: "近 7 天实体巡检", value: `${entity7} 轮` },
    ],
    sources: ["biz_events（intel_card.emit/entity.scan）"],
  };
}

/** 能见度与账号表现：采集轮次 + 平台指标 */
async function visibilityFacts(app: pg.Pool, scope: Scope): Promise<{ facts: AskFact[]; sources: string[] }> {
  const [collect7, metricRows] = await Promise.all([
    countActions(app, scope, ["visibility.collect"], 7),
    scopedQuery<{ platform: string; plays: string; engagements: string; conversions: string }>(app, scope,
      `SELECT platform,
              sum(plays)::text AS plays,
              sum(likes + comments + shares)::text AS engagements,
              sum(conversions)::text AS conversions
         FROM account_metrics
        WHERE workspace_id=$1 AND captured_at > now() - interval '7 days'
        GROUP BY platform ORDER BY sum(plays) DESC LIMIT 5`, [scope.workspaceId]),
  ]);
  const facts: AskFact[] = [{ label: "近 7 天能见度采集", value: `${collect7} 轮` }];
  if (metricRows.length > 0) {
    facts.push({
      label: "近 7 天账号表现（播放/互动/转化）",
      value: metricRows.map((r) => `${r.platform} ${r.plays}/${r.engagements}/${r.conversions}`).join(" · "),
    });
  }
  return { facts, sources: ["biz_events（visibility.collect）", "account_metrics"] };
}

/** 承接与经营：私域咨询打标 / CEO 决策与简报 */
async function conversionFacts(app: pg.Pool, scope: Scope): Promise<{ facts: AskFact[]; sources: string[] }> {
  const [inquiry7, briefing7, decision7] = await Promise.all([
    countActions(app, scope, ["inquiry.tag"], 7),
    countActions(app, scope, ["ceo.briefing", "report.weekly"], 7),
    countActions(app, scope, ["ceo.decision"], 7),
  ]);
  return {
    facts: [
      { label: "近 7 天私域咨询打标", value: `${inquiry7} 条` },
      { label: "近 7 天经营简报", value: `${briefing7} 份` },
      { label: "近 7 天 CEO 决策", value: `${decision7} 项` },
    ],
    sources: ["biz_events（inquiry.tag/ceo.briefing/report.weekly/ceo.decision）"],
  };
}

/** 关键词 → 事实域（问题里没提就按"全域概览"给一组） */
function domainsFor(question: string): Array<"content" | "intel" | "visibility" | "conversion"> {
  const domains: Array<"content" | "intel" | "visibility" | "conversion"> = [];
  const push = (d: typeof domains[number]) => { if (!domains.includes(d)) domains.push(d); };
  if (/内容|发布|分发|改写|排期|素材|选题/.test(question)) push("content");
  if (/情报|竞品|实体|信源|档案/.test(question)) push("intel");
  if (/能见度|上榜|曝光|播放|互动|账号|平台|GEO|AI 答案|排名/.test(question)) push("visibility");
  if (/线索|咨询|承接|转化|私域|订单|决策|简报|复盘|经营/.test(question)) push("conversion");
  if (domains.length === 0) { push("content"); push("visibility"); push("conversion"); }
  return domains;
}

export function createAskFactProvider(): AskFactProvider {
  return async (app, scope, question) => {
    const facts: AskFact[] = [];
    const sources: string[] = [];
    for (const domain of domainsFor(question)) {
      const part = domain === "content" ? await contentFacts(app, scope)
        : domain === "intel" ? await intelFacts(app, scope)
          : domain === "visibility" ? await visibilityFacts(app, scope)
            : await conversionFacts(app, scope);
      facts.push(...part.facts);
      sources.push(...part.sources);
    }
    return { facts, sources };
  };
}

export const ASK_FACT_INDUSTRY = "geo-growth";
/** 兼容别名（行业前缀命名，便于人工检索） */
export const createGeoAskFactProvider = createAskFactProvider;
