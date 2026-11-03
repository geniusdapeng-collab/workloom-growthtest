import { describe, expect, it } from "vitest";
import { compilePipeline, pipelineSha256 } from "./compiler.js";
import { PipelineCoordinator } from "./coordinator.js";
import { InMemoryPipelineRepository } from "./in-memory-repository.js";

describe("自动门裁决在控制面投影中保持相同语义", () => {
  it.each([
    ["passed", "continue", "run_node"],
    ["rejected", "repair", "repair"],
    ["unverified", "reconcile", "reconcile"],
  ] as const)("%s 不能在投影中退回not_run", async (decision, disposition, nextAction) => {
    const scope = { tenantId: "tenant-projection", workspaceId: "ws-projection" };
    const plan = compilePipeline({ quest: "auto-projection", name: "projection", version: 1,
      steps: [{ step_key: "prompt", name: "prompt", owner: "writer", gate: "G6", outputs: ["prompt_package"] }],
    }, { adapterRegistry: [{ id: "vendor-preproduction", pipelineKeys: ["auto-projection"] }] });
    const coordinator = new PipelineCoordinator(new InMemoryPipelineRepository(), {
      autoApproveGate: () => ({ decision, actor: "video-auto-approval", policyVersion: "test/v1", reason: "test result" }),
    });
    const factsSnapshotHash = pipelineSha256("facts");
    const { pipelineRunId } = await coordinator.startCompiledPipeline(scope, plan, {
      projectId: "VID-projection", planKey: plan.pipelineKey, factsSnapshotHash, budgetGrantId: null,
      expectedProjectRevision: 0, idempotencyKey: "start", createdBy: "test", sourceSystem: "test", sourceRunId: "RUN-projection",
    });
    await coordinator.beginStage(scope, { pipelineRunId, nodeKey: "prompt", idempotencyKey: "begin" });
    const sha256 = pipelineSha256("prompt");
    await coordinator.recordStageOutput(scope, { pipelineRunId, nodeKey: "prompt", idempotencyKey: "output",
      artifacts: [{ role: "prompt_package", schemaVersion: "test/v1", ref: "prompt.json", sha256, logicalHash: sha256, factsSnapshotHash, contentType: "application/json" }],
    });
    const saved = await coordinator.requestGate(scope, { pipelineRunId, nodeKey: "prompt", idempotencyKey: "gate", gateKey: "G6", checkSetVersion: "test/v1", artifactHashes: [sha256] });
    expect(saved.verificationStatus).toBe(decision);
    const projection = await coordinator.readProjection(scope, pipelineRunId);
    expect(projection?.stages[0]).toMatchObject({ verificationStatus: decision, disposition });
    expect(projection?.stages[0]?.gateDecisionIds).toHaveLength(1);
    expect(projection?.nextAction).toBe(nextAction);
  });
});
