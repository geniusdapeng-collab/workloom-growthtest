import { scopedQuery, type AppPool } from "./gen/db.js";

type PipelineKind = "marketing" | "narrative";

export interface PromptMetricEvent {
  [key: string]: unknown;
  action: string;
  projectId: string;
  createdAt: string;
  after: Record<string, unknown>;
}

export interface PromptSuccessBucket {
  projects: number;
  preflightChecks: number;
  preflightPassed: number;
  g6Reviews: number;
  g6Passed: number;
  repairRequested: number;
  repairCompleted: number;
  repairExhausted: number;
  repairBlocked: number;
  repairModelCalls: number;
}

export interface PromptSuccessMetrics {
  since: string;
  marketing: PromptSuccessBucket;
  narrative: PromptSuccessBucket;
  unknown: PromptSuccessBucket;
}

const empty = (): PromptSuccessBucket => ({
  projects: 0,
  preflightChecks: 0,
  preflightPassed: 0,
  g6Reviews: 0,
  g6Passed: 0,
  repairRequested: 0,
  repairCompleted: 0,
  repairExhausted: 0,
  repairBlocked: 0,
  repairModelCalls: 0,
});

export function aggregatePromptSuccessMetrics(
  events: readonly PromptMetricEvent[],
  options: { since: string },
): PromptSuccessMetrics {
  const result: PromptSuccessMetrics = {
    since: options.since,
    marketing: empty(),
    narrative: empty(),
    unknown: empty(),
  };
  const projects = {
    marketing: new Set<string>(),
    narrative: new Set<string>(),
    unknown: new Set<string>(),
  };
  for (const event of events) {
    const kindValue = event.after.pipelineKind;
    const kind: PipelineKind | "unknown" = kindValue === "marketing" || kindValue === "narrative" ? kindValue : "unknown";
    const bucket = result[kind];
    projects[kind].add(event.projectId);
    if (event.action === "video.prompt.preflight") {
      bucket.preflightChecks += 1;
      if (event.after.approved === true) bucket.preflightPassed += 1;
    } else if (event.action === "prompt.confirm") {
      bucket.g6Reviews += 1;
      if (event.after.approved === true) bucket.g6Passed += 1;
    } else if (event.action === "pipeline.prompt.repair_requested") {
      bucket.repairRequested += 1;
    } else if (event.action === "pipeline.prompt.repair_completed") {
      bucket.repairCompleted += 1;
      bucket.repairModelCalls += promptBudgetCalls(event.after.budget);
    } else if (event.action === "pipeline.prompt.repair_exhausted") {
      bucket.repairExhausted += 1;
      bucket.repairModelCalls += promptBudgetCalls(event.after.budget);
    } else if (event.action === "pipeline.prompt.repair_blocked") {
      bucket.repairBlocked += 1;
    }
  }
  for (const key of ["marketing", "narrative", "unknown"] as const) result[key].projects = projects[key].size;
  return result;
}

function promptBudgetCalls(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const used = Number((value as Record<string, unknown>).usedTextCalls);
  return Number.isSafeInteger(used) && used >= 0 ? used : 0;
}

export async function readPromptSuccessMetrics(
  app: AppPool,
  scope: { tenantId: string; workspaceId: string },
  since: string,
): Promise<PromptSuccessMetrics> {
  const rows = await scopedQuery<PromptMetricEvent>(app, scope,
    `SELECT payload->'decision'->>'action' AS action,
      COALESCE(payload->'decision'->'after'->>'projectId', split_part(payload->'object'->>'id', ':', 1)) AS "projectId",
      created_at::text AS "createdAt",
      payload->'decision'->'after' AS after
     FROM biz_events
     WHERE workspace_id=$1 AND tenant_id=$2
       AND created_at >= $3::timestamptz
       AND payload->'decision'->>'action' = ANY($4::text[])
     ORDER BY created_at, event_id`,
    [scope.workspaceId, scope.tenantId, since, [
      "video.prompt.preflight",
      "prompt.confirm",
      "pipeline.prompt.repair_requested",
      "pipeline.prompt.repair_completed",
      "pipeline.prompt.repair_exhausted",
      "pipeline.prompt.repair_blocked",
    ]]);
  return aggregatePromptSuccessMetrics(rows.map(row => ({
    ...row,
    after: row.after && typeof row.after === "object" && !Array.isArray(row.after)
      ? row.after as Record<string, unknown>
      : {},
  })), { since });
}
