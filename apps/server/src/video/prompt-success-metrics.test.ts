import { describe, expect, it } from "vitest";
import { aggregatePromptSuccessMetrics } from "./prompt-success-metrics.js";

describe("prompt success metrics", () => {
  it("separates marketing/narrative preflight, G6 and bounded repair outcomes", () => {
    const metrics = aggregatePromptSuccessMetrics([
      { action: "video.prompt.preflight", projectId: "M1", createdAt: "2026-11-08T00:00:00Z", after: { pipelineKind: "marketing", approved: false } },
      { action: "prompt.confirm", projectId: "M1", createdAt: "2026-11-08T00:01:00Z", after: { pipelineKind: "marketing", approved: false } },
      { action: "pipeline.prompt.repair_requested", projectId: "M1", createdAt: "2026-11-08T00:02:00Z", after: { pipelineKind: "marketing" } },
      { action: "pipeline.prompt.repair_completed", projectId: "M1", createdAt: "2026-11-08T00:03:00Z",
        after: { pipelineKind: "marketing", budget: { usedTextCalls: 3 } } },
      { action: "video.prompt.preflight", projectId: "N1", createdAt: "2026-11-08T00:00:00Z", after: { pipelineKind: "narrative", approved: true } },
      { action: "prompt.confirm", projectId: "N1", createdAt: "2026-11-08T00:01:00Z", after: { pipelineKind: "narrative", approved: true } },
    ], { since: "2026-11-08T00:00:00Z" });
    expect(metrics.marketing).toMatchObject({
      projects: 1, preflightChecks: 1, preflightPassed: 0, g6Reviews: 1, g6Passed: 0,
      repairRequested: 1, repairCompleted: 1, repairExhausted: 0, repairBlocked: 0, repairModelCalls: 3,
    });
    expect(metrics.narrative).toMatchObject({
      projects: 1, preflightChecks: 1, preflightPassed: 1, g6Reviews: 1, g6Passed: 1,
    });
  });
});
