/**
 * base/captain · 开户即托管（《GROWTH 深度产品方案》§3 P0 服务端内核）
 *
 * 语义（终态判据「没有客户操作，这件事还会不会发生」）：
 *   平台开户(provisionShadowWorkspace)
 *     → 自动装配组合编制（agents + 围栏）
 *     → 默认进入 shadow：完整推理、事件标 dry_run、不产生对外动作
 *   → 影子周期(runShadowCycle) 产出简报/队列裁决/偏差扫描
 *   → 影子对照报告(generateShadowReport) 落账，客户首次登录即见
 *   → 客户确认转正(advanceFromShadow)：shadow → trial（到期仍按既有规则降级，绝不自动转正式）。
 *
 * 边界：本模块不改围栏判级、不做外部动作；shadow 档下的写路径一律 dry_run 留痕。
 */
import type pg from "pg";
import { gatewayAppendOnClient, type ActorInfo } from "@workloom/base/workdata";
import { provisionComposedWorkforce } from "../bundles/assembly.js";
import { transition, type Charter } from "./charter.js";
import {
  ceoActor, loadCharter, saveCharter,
  runBriefingBeat, runQueueBeat, runDeviationBeat, type Scope,
} from "./loop.js";

export const AUTO_SHADOW_DISCLOSURE_VERSION = "auto-shadow-v1";

/** 平台开户的默认授权条款（与深度授权六步同源口径；转正时由客户逐项确认）。 */
export const AUTO_SHADOW_CLAUSES = [
  "平台开户：系统自动装配团队与边界，默认进入影子模式（只推理、不执行对外动作）",
  "影子期的判断与汇报全程留痕，随时可回看；转正前不产生任何真实对外动作",
  "转正需客户确认（授权六步）；转正后仍保留随时叫停与回滚权",
] as const;

export interface ProvisionShadowInput {
  tenantId: string;
  tenantName?: string;
  workspaceId: string;
  workspaceName: string;
  slug: string;
  /** 组合主包（product.manifest.json#defaultBundle，例如 geo-growth）。 */
  primaryBundle: string;
  /** 开户发起方（平台运营/系统账号），进账本。 */
  by: string;
  shadowDays?: number;
  trialDays?: number;
}

export interface ProvisionShadowResult {
  workspaceId: string;
  bundleIds: string[];
  rosterSize: number;
  fenceRules: number;
  shadowed: number;
  charterMode: Charter["mode"];
}

async function inTx<T>(app: pg.Pool, scope: Scope, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function emit(
  client: pg.PoolClient, scope: Scope, actor: ActorInfo, action: string,
  decision: { params?: Record<string, unknown>; after?: Record<string, unknown>; basis: string[] },
  opts?: { dryRun?: boolean; objectType?: string },
): Promise<string> {
  const res = await gatewayAppendOnClient(client, {
    ...scope, actor, sessionId: `onboarding-${scope.workspaceId}`,
  }, {
    who: { type: actor.type, id: actor.id },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString() },
    object: { type: opts?.objectType ?? "workspace", id: scope.workspaceId },
    decision: {
      action,
      params: { ...(decision.params ?? {}), ...(opts?.dryRun ? { dry_run: true } : {}) },
      after: decision.after ?? {},
      basis: decision.basis,
    },
    rule_impact: [],
    model_trace: { model_id: process.env.LLM_MODEL || "mock-001", tier: "standard", credits: 1 },
  });
  return res.eventId;
}

/** 平台开户：建租户/工作区/档案 → 组合装配 → 默认影子授权（幂等）。 */
export async function provisionShadowWorkspace(
  app: pg.Pool, input: ProvisionShadowInput,
): Promise<ProvisionShadowResult> {
  const scope: Scope = { tenantId: input.tenantId, workspaceId: input.workspaceId };
  const shadowDays = input.shadowDays ?? 3;
  const trialDays = input.trialDays ?? 7;

  await app.query(
    `INSERT INTO tenants (id, name, plan) VALUES ($1,$2,'pro') ON CONFLICT (id) DO NOTHING`,
    [input.tenantId, input.tenantName ?? input.tenantId],
  );
  await app.query(
    `INSERT INTO workspaces (id, tenant_id, name, slug, industry, stage, night_config)
     VALUES ($1,$2,$3,$4,$5,'onboarding',$6)
     ON CONFLICT (id) DO UPDATE SET industry = EXCLUDED.industry`,
    [input.workspaceId, input.tenantId, input.workspaceName, input.slug, input.primaryBundle,
      JSON.stringify({ enabled: true, candidateTime: "18:00", startTime: "22:00", packageTime: "08:30", timezone: "Asia/Shanghai" })],
  );
  await app.query(
    `INSERT INTO profiles (workspace_id, tenant_id, industry, archive, forbidden, pii_vault)
     VALUES ($1,$2,$3,$4,'[]'::jsonb,NULL)
     ON CONFLICT (workspace_id) DO NOTHING`,
    [input.workspaceId, input.tenantId, input.primaryBundle, JSON.stringify({ industry: input.primaryBundle, dataMode: "simulated" })],
  );

  const composed = await provisionComposedWorkforce(app, scope, input.primaryBundle, input.by);

  const charter = await loadCharter(app, scope);
  if (charter.mode !== "disabled") {
    return {
      workspaceId: input.workspaceId,
      bundleIds: composed.bundleIds,
      rosterSize: composed.rosterSize,
      fenceRules: composed.fenceRules,
      shadowed: composed.shadowed.length,
      charterMode: charter.mode,
    };
  }
  const grantedAt = new Date().toISOString();
  const next = transition(charter, {
    kind: "grant",
    grant: {
      event_id: "", granted_by: input.by, granted_at: grantedAt,
      disclosure_version: AUTO_SHADOW_DISCLOSURE_VERSION, clauses: [...AUTO_SHADOW_CLAUSES],
      shadow_days: shadowDays, trial_days: trialDays, trial_ends_at: null, retain_until: null,
    },
  });
  await inTx(app, scope, async (client) => {
    const eventId = await emit(client, scope, { id: input.by, type: "human" }, "captain.grant", {
      params: {
        auto: true, disclosure_version: AUTO_SHADOW_DISCLOSURE_VERSION,
        clauses: [...AUTO_SHADOW_CLAUSES], shadow_days: shadowDays, trial_days: trialDays,
      },
      after: { mode: next.mode },
      basis: [
        "开户即托管：平台侧一次接管（自动装配 + 默认影子档）",
        "影子档只推理不执行：所有写路径按 dry_run 留痕，转正前无对外动作",
      ],
    });
    next.grant = { ...next.grant!, event_id: eventId };
    await saveCharter(client, scope, next);
  });

  return {
    workspaceId: input.workspaceId,
    bundleIds: composed.bundleIds,
    rosterSize: composed.rosterSize,
    fenceRules: composed.fenceRules,
    shadowed: composed.shadowed.length,
    charterMode: next.mode,
  };
}

/** 影子周期：跑一轮 CEO 节拍（简报/队列/偏差扫描），全部 dry_run 留痕。 */
export async function runShadowCycle(app: pg.Pool, scope: Scope): Promise<{
  briefing: Awaited<ReturnType<typeof runBriefingBeat>>;
  queue: Awaited<ReturnType<typeof runQueueBeat>>;
  deviation: Awaited<ReturnType<typeof runDeviationBeat>>;
}> {
  const charter = await loadCharter(app, scope);
  if (charter.mode !== "shadow") {
    throw new Error(`runShadowCycle 仅适用于 shadow 档（当前 ${charter.mode}）`);
  }
  return {
    briefing: await runBriefingBeat(app, scope, "daily"),
    queue: await runQueueBeat(app, scope),
    deviation: await runDeviationBeat(app, scope),
  };
}

export interface ShadowDecisionEvent {
  eventId: string;
  action: string;
  title: string;
  outcome: string;
  domain: string;
  time?: string;
}

export interface ShadowReport {
  version: "shadow-report/v1";
  windowStart: string;
  windowEnd: string;
  totals: { decisions: number; byOutcome: Record<string, number>; byDomain: Record<string, number> };
  highlights: ShadowDecisionEvent[];
  escalations: ShadowDecisionEvent[];
  text: string;
}

/** 影子对照报告（纯函数）：把 dry_run 事件聚合成"客户首登第一眼"的中文报告。 */
export function buildShadowReport(
  events: readonly ShadowDecisionEvent[],
  meta: { workspaceName?: string; windowStart: string; windowEnd: string },
): ShadowReport {
  const byOutcome: Record<string, number> = {};
  const byDomain: Record<string, number> = {};
  for (const e of events) {
    byOutcome[e.outcome] = (byOutcome[e.outcome] ?? 0) + 1;
    byDomain[e.domain] = (byDomain[e.domain] ?? 0) + 1;
  }
  const escalations = events.filter((e) => e.outcome === "escalate").slice(0, 5);
  const highlights = events.slice(0, 5);
  const domainLine = Object.entries(byDomain)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v} 件`)
    .join("；") || "（本窗口暂无判断）";
  const escalationLine = escalations.length
    ? escalations.map((e) => `· ${e.title}`).join("\n")
    : "无（本窗口没有需要你拍板的事项）";
  const text = [
    `【影子模式对照报告 · ${meta.workspaceName ?? "工作区"}】`,
    `窗口：${meta.windowStart} → ${meta.windowEnd}`,
    `本窗口系统完整推理 ${events.length} 件决策（通过 ${byOutcome.approve ?? 0} / 上浮 ${byOutcome.escalate ?? 0} / 阻断 ${byOutcome.block ?? 0} / 其他 ${(byOutcome.other ?? 0) + (byOutcome.reject ?? 0)}），全部只留痕、未执行。`,
    `- 判断概览：${domainLine}`,
    `- 需要你关注：`,
    escalationLine,
    `- 说明：以上判断在转正前不会产生任何对外动作；转正后按自治档位执行，随时可叫停。`,
  ].join("\n");
  return {
    version: "shadow-report/v1",
    windowStart: meta.windowStart,
    windowEnd: meta.windowEnd,
    totals: { decisions: events.length, byOutcome, byDomain },
    highlights,
    escalations,
    text,
  };
}

function outcomeOf(payload: Record<string, unknown>): string {
  const decision = (payload.decision ?? {}) as Record<string, unknown>;
  const after = (decision.after ?? {}) as Record<string, unknown>;
  const params = (decision.params ?? {}) as Record<string, unknown>;
  const raw = String(after.verdict ?? params.verdict ?? after.mode ?? "").toLowerCase();
  if (/escalat|上浮|请示/.test(raw)) return "escalate";
  if (/block|阻断/.test(raw)) return "block";
  if (/reject|驳回/.test(raw)) return "reject";
  if (/approve|采纳|通过|hit|命中/.test(raw)) return "approve";
  return "other";
}

function domainOf(action: string): string {
  const prefix = action.split(".")[0] ?? action;
  const labels: Record<string, string> = {
    ceo: "公司经营", captain: "治理与授权", goal: "目标偏差", hr: "员工管理", org: "编制",
    ads: "投放", roi: "投放", script: "内容", publish: "发布", source: "信源", metrics: "数据",
    visibility: "能见度", inquiry: "询盘", growth: "增长实验", citation: "引用分析", intel: "情报",
  };
  return labels[prefix] ?? prefix;
}

/** 从账本聚合影子窗口 → 生成并落账《影子对照报告》。 */
export async function generateShadowReport(
  app: pg.Pool, scope: Scope, opts: { windowHours?: number; workspaceName?: string } = {},
): Promise<{ report: ShadowReport; eventId: string }> {
  const windowHours = opts.windowHours ?? 24;
  const rows = await app.query<{ event_id: string; payload: Record<string, unknown>; created_at: Date }>(
    `SELECT event_id, payload, created_at FROM biz_events
      WHERE workspace_id=$1
        AND payload->'decision'->'params'->>'dry_run' = 'true'
        AND created_at >= now() - ($2::text || ' hours')::interval
      ORDER BY seq`,
    [scope.workspaceId, String(windowHours)],
  );
  const events: ShadowDecisionEvent[] = rows.rows.map((r) => {
    const payload = r.payload ?? {};
    const decision = (payload.decision ?? {}) as Record<string, unknown>;
    const after = (decision.after ?? {}) as Record<string, unknown>;
    const params = (decision.params ?? {}) as Record<string, unknown>;
    const action = String(decision.action ?? "unknown");
    return {
      eventId: r.event_id,
      action,
      title: String(params.title ?? after.title ?? `${domainOf(action)}：${action}`),
      outcome: outcomeOf(payload),
      domain: domainOf(action),
      time: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    };
  });
  const now = new Date();
  const report = buildShadowReport(events, {
    workspaceName: opts.workspaceName,
    windowStart: new Date(now.getTime() - windowHours * 3600_000).toISOString(),
    windowEnd: now.toISOString(),
  });
  const eventId = await inTx(app, scope, async (client) => {
    const actor = await ceoActor(client, scope);
    return emit(client, scope, actor, "ceo.shadow_report", {
      params: { window_hours: windowHours, decisions: report.totals.decisions },
      after: { text: report.text, totals: report.totals, highlights: report.highlights },
      basis: [
        `影子窗口 ${windowHours}h 内 dry_run 决策 ${report.totals.decisions} 件（只推理未执行）`,
        "转正前不产生任何对外动作；转正后按自治档位执行，随时可叫停",
      ],
    }, { objectType: "shadow_report" });
  });
  return { report, eventId };
}

/** 客户转正：shadow → trial（需显式确认；到期仍由既有到期链路降级，不自动转正式）。 */
export async function advanceFromShadow(
  app: pg.Pool, scope: Scope, opts: { by: string; confirmed: boolean },
): Promise<Charter> {
  if (!opts.confirmed) throw new Error("转正需客户显式确认（授权六步口径）");
  const charter = await loadCharter(app, scope);
  if (charter.mode !== "shadow") throw new Error(`仅影子期可转正（当前 ${charter.mode}）`);
  const next = transition(charter, { kind: "advance" });
  await inTx(app, scope, async (client) => {
    await emit(client, scope, { id: opts.by, type: "human" }, "captain.mode_change", {
      params: { from: "shadow", to: "trial", by: opts.by },
      after: { mode: next.mode, trial_ends_at: next.grant?.trial_ends_at ?? null },
      basis: ["客户确认转正：影子 → 试用（到期自动降级，绝不自动转正式）"],
    });
    await saveCharter(client, scope, next);
  });
  return next;
}

/** 首次登录载荷：最新影子报告 + 最新简报（客户"第一眼"看到的内容）。 */
export async function firstLoginPayload(app: pg.Pool, scope: Scope): Promise<{
  shadowReport: { eventId: string; text: string; totals: Record<string, unknown> } | null;
  briefing: { eventId: string; text: string } | null;
}> {
  const report = await app.query<{ event_id: string; payload: Record<string, unknown> }>(
    `SELECT event_id, payload FROM biz_events
      WHERE workspace_id=$1 AND payload->'decision'->>'action'='ceo.shadow_report'
      ORDER BY seq DESC LIMIT 1`,
    [scope.workspaceId],
  );
  const brief = await app.query<{ event_id: string; payload: Record<string, unknown> }>(
    `SELECT event_id, payload FROM biz_events
      WHERE workspace_id=$1 AND payload->'decision'->>'action'='ceo.briefing'
      ORDER BY seq DESC LIMIT 1`,
    [scope.workspaceId],
  );
  const r0 = report.rows[0];
  const b0 = brief.rows[0];
  return {
    shadowReport: r0
      ? {
        eventId: r0.event_id,
        text: String((r0.payload.decision as Record<string, unknown>)?.after instanceof Object
          ? ((r0.payload.decision as Record<string, unknown>).after as Record<string, unknown>).text ?? ""
          : ""),
        totals: (((r0.payload.decision as Record<string, unknown>)?.after ?? {}) as Record<string, unknown>).totals as Record<string, unknown> ?? {},
      }
      : null,
    briefing: b0
      ? {
        eventId: b0.event_id,
        text: String((((b0.payload.decision as Record<string, unknown>)?.after ?? {}) as Record<string, unknown>).text ?? ""),
      }
      : null,
  };
}
