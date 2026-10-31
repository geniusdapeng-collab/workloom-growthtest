import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  DEFAULT_KNOWN_GATES,
  compilePipeline,
  parseAndCompilePipeline,
  pipelineSha256,
} from "./compiler.js";
import type { CompiledPipelinePlan } from "./contracts.js";
import { InMemoryPipelineRepository } from "./in-memory-repository.js";
import { PipelineCoordinator } from "./coordinator.js";
import { PipelineShadowSession } from "./shadow.js";
import { PipelineStateError, assertExecutionTransition } from "./state.js";
import { pipelineControlStateLockKey, projectExecutionLeaseKey } from "./lease.js";
import { PipelineCompileError } from "./compiler.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../../../..");
const PIPELINES = path.join(ROOT, "bundles/ai-video/pipelines");
const PRESETS = path.join(ROOT, "bundles/ai-video/presets");
const SCOPE = { tenantId: "tenant-1", workspaceId: "workspace-1" };
const FACTS = "a".repeat(64);

function fixedNow(): string {
  return "2026-10-30T12:00:00.000Z";
}

function ids(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

function testPlan(): CompiledPipelinePlan {
  return compilePipeline({
    quest: "test-film",
    name: "测试管线",
    version: "v1",
    steps: [
      { step_key: "script", name: "剧本", owner: "scriptwriter", outputs: ["script_blueprint"] },
      { step_key: "post", name: "后期", owner: "post-editor", outputs: ["final_video"] },
    ],
  }, {
    adapterRegistry: [{ id: "vendor-preproduction", pipelineKeys: ["test-film"], stepKeys: ["script"] },
      { id: "render-post", pipelineKeys: ["test-film"], stepKeys: ["post"] }],
    knownGates: new Set(["G1"]),
  });
}

function artifact(factsSnapshotHash = FACTS) {
  const sha256 = pipelineSha256({ output: "ok" });
  return {
    role: "script_blueprint",
    schemaVersion: "workloom.script/v1",
    ref: `artifacts/${sha256}.json`,
    sha256,
    logicalHash: sha256,
    factsSnapshotHash,
    contentType: "application/json",
  };
}

function coordinator(): PipelineCoordinator {
  const sequence = new Map<string, () => string>();
  const id = (prefix: string) => (sequence.get(prefix) ?? sequence.set(prefix, ids(prefix)).get(prefix)!);
  return new PipelineCoordinator(new InMemoryPipelineRepository(), {
    now: fixedNow,
    ids: {
      runId: id("PR"),
      stageRunId: id("SR"),
      artifactId: id("AV"),
      gateDecisionId: id("GD"),
      eventId: id("EV"),
    },
    autoApproveGate: () => ({
      decision: "passed",
      actor: "video-auto-approval",
      policyVersion: "workloom.video-auto-approval/v1",
      reason: "test auto approval after quality review",
      evidenceHashes: ["a".repeat(64)],
    }),
  });
}

describe("CompiledPipelinePlan", () => {
  it("compiles every shipped ai-video pipeline with registered owners, gates and adapters", async () => {
    const owners = new Set<string>();
    for (const name of await readdir(PRESETS)) {
      if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
      const preset = YAML.parse(await readFile(path.join(PRESETS, name), "utf8")) as { preset_key?: string };
      if (preset.preset_key) owners.add(preset.preset_key);
    }
    const plans: CompiledPipelinePlan[] = [];
    for (const name of (await readdir(PIPELINES)).filter(entry => entry.endsWith(".yml")).sort()) {
      plans.push(parseAndCompilePipeline(await readFile(path.join(PIPELINES, name), "utf8"), {
        knownOwners: owners,
        knownGates: DEFAULT_KNOWN_GATES,
      }));
    }
    expect(plans).toHaveLength(6);
    expect(plans.map(plan => plan.pipelineKey).sort()).toEqual([
      "account-ops",
      "ads-creative-factory",
      "explainer-film",
      "marketing-film",
      "narrative-film",
      "settlement-recon",
    ]);
    for (const plan of plans) {
      expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/);
      expect(plan.topologicalOrder).toHaveLength(plan.steps.length);
      expect(plan.steps.every(step => step.adapterId !== "__unresolved__")).toBe(true);
    }
  });

  it("rejects cycles and unknown adapters before runtime", () => {
    expect(() => compilePipeline({
      quest: "cycle",
      name: "环",
      version: "v1",
      steps: [
        { step_key: "a", name: "A", owner: "director", outputs: ["x"], depends_on: ["b"] },
        { step_key: "b", name: "B", owner: "director", outputs: ["y"], depends_on: ["a"] },
      ],
    }, {
      adapterRegistry: [{ id: "x", pipelineKeys: ["cycle"] }],
    })).toThrow(PipelineCompileError);
    expect(() => compilePipeline({
      quest: "missing-adapter",
      name: "缺适配器",
      version: "v1",
      steps: [{ step_key: "a", name: "A", owner: "director", outputs: ["x"] }],
    }, {
      adapterRegistry: [],
    })).toThrow(/UNKNOWN_ADAPTER/);
  });
});

describe("PipelineCoordinator", () => {
  it("persists double state and enforces idempotent commands", async () => {
    const c = coordinator();
    const plan = testPlan();
    const startInput = {
      projectId: "VID-1",
      planKey: plan.pipelineKey,
      factsSnapshotHash: FACTS,
      budgetGrantId: null,
      expectedProjectRevision: 0,
      idempotencyKey: "start-1",
      createdBy: "test",
      sourceSystem: "unit",
      sourceRunId: "run-1",
    };
    const started = await c.startCompiledPipeline(SCOPE, plan, startInput);
    const replay = await c.startCompiledPipeline(SCOPE, plan, startInput);
    expect(replay).toEqual(started);
    const initial = await c.readProjection(SCOPE, started.pipelineRunId);
    expect(initial?.nextAction).toBe("run_node");
    expect(initial?.stages.every(stage => stage.itemKey === "")).toBe(true);

    await c.beginStage(SCOPE, {
      pipelineRunId: started.pipelineRunId,
      nodeKey: "script",
      idempotencyKey: "script-begin",
    });
    const output = await c.recordStageOutput(SCOPE, {
      pipelineRunId: started.pipelineRunId,
      nodeKey: "script",
      idempotencyKey: "script-output",
      artifacts: [artifact()],
    });
    expect(output.stage.executionStatus).toBe("output_ready");
    expect(output.stage.verificationStatus).toBe("not_run");
    const completed = await c.finishStage(SCOPE, {
      pipelineRunId: started.pipelineRunId,
      nodeKey: "script",
      idempotencyKey: "script-finish",
      status: "completed",
    });
    expect(completed.executionStatus).toBe("completed");
    expect(completed.verificationStatus).toBe("not_run");

    const run = await c.getRun(SCOPE, started.pipelineRunId);
    expect(run?.currentFrontier).toEqual(["post"]);
    expect(run?.revision).toBe(2);
  });

  it("binds gate decisions to exact artifact hashes and never conflates rejection with execution failure", async () => {
    const c = coordinator();
    const plan = testPlan();
    const started = await c.startCompiledPipeline(SCOPE, plan, {
      projectId: "VID-2",
      planKey: plan.pipelineKey,
      factsSnapshotHash: FACTS,
      budgetGrantId: null,
      expectedProjectRevision: 0,
      idempotencyKey: "start-2",
      createdBy: "test",
      sourceSystem: "unit",
      sourceRunId: "run-2",
    });
    await c.beginStage(SCOPE, {
      pipelineRunId: started.pipelineRunId,
      nodeKey: "script",
      idempotencyKey: "script-begin-2",
    });
    const out = await c.recordStageOutput(SCOPE, {
      pipelineRunId: started.pipelineRunId,
      nodeKey: "script",
      idempotencyKey: "script-output-2",
      artifacts: [artifact()],
    });
    await expect(c.recordGateDecision(SCOPE, {
      pipelineRunId: started.pipelineRunId,
      nodeKey: "script",
      idempotencyKey: "gate-bad-hash",
      gateKey: "G1",
      checkSetVersion: "v1",
      decision: "passed",
      actor: "reviewer",
      artifactHashes: ["b".repeat(64)],
    })).rejects.toThrow(/GATE_ARTIFACT_MISMATCH/);
    const decision = await c.recordGateDecision(SCOPE, {
      pipelineRunId: started.pipelineRunId,
      nodeKey: "script",
      idempotencyKey: "gate-rejected",
      gateKey: "G1",
      checkSetVersion: "v1",
      decision: "rejected",
      actor: "reviewer",
      artifactHashes: [out.artifacts[0]!.sha256],
      issues: ["字段缺失"],
      findings: [{
        code: "G1_FIELD_MISSING",
        severity: "P1",
        targetType: "field",
        targetId: "script",
        fieldPath: "source",
        expected: "evidence",
        actual: null,
        evidenceRefs: ["artifact:script"],
        repairClass: "semantic",
        blocking: true,
      }],
    });
    expect(decision.decision).toBe("rejected");
    expect(decision.artifactManifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(decision.findings[0]?.code).toBe("G1_FIELD_MISSING");
    const run = await c.getRun(SCOPE, started.pipelineRunId);
    expect(run?.status).toBe("running");
    const projection = await c.readProjection(SCOPE, started.pipelineRunId);
    expect(projection?.nextAction).toBe("repair");
    expect(projection?.blocker?.kind).toBe("repair");
  });

  it("rejects a stale artifact manifest hash before persisting a gate decision", async () => {
    const c = coordinator();
    const plan = testPlan();
    const started = await c.startCompiledPipeline(SCOPE, plan, {
      projectId: "VID-MANIFEST",
      planKey: plan.pipelineKey,
      factsSnapshotHash: FACTS,
      budgetGrantId: null,
      expectedProjectRevision: 0,
      idempotencyKey: "start-manifest",
      createdBy: "test",
      sourceSystem: "unit",
      sourceRunId: "run-manifest",
    });
    await c.beginStage(SCOPE, {
      pipelineRunId: started.pipelineRunId,
      nodeKey: "script",
      idempotencyKey: "begin-manifest",
    });
    const output = await c.recordStageOutput(SCOPE, {
      pipelineRunId: started.pipelineRunId,
      nodeKey: "script",
      idempotencyKey: "output-manifest",
      artifacts: [artifact()],
    });
    await expect(c.recordGateDecision(SCOPE, {
      pipelineRunId: started.pipelineRunId,
      nodeKey: "script",
      idempotencyKey: "gate-manifest",
      gateKey: "G1",
      checkSetVersion: "v1",
      artifactManifestHash: "b".repeat(64),
      decision: "passed",
      actor: "reviewer",
      artifactHashes: [output.artifacts[0]!.sha256],
    })).rejects.toThrow(/GATE_MANIFEST_MISMATCH/);
  });

  it("auto-approves a video gate after quality evidence without creating a human wait", async () => {
    const c = coordinator();
    const plan = testPlan();
    const started = await c.startCompiledPipeline(SCOPE, plan, {
      projectId: "VID-PENDING",
      planKey: plan.pipelineKey,
      factsSnapshotHash: FACTS,
      budgetGrantId: null,
      expectedProjectRevision: 0,
      idempotencyKey: "start-pending",
      createdBy: "test",
      sourceSystem: "unit",
      sourceRunId: "run-pending",
    });
    await c.beginStage(SCOPE, {
      pipelineRunId: started.pipelineRunId,
      nodeKey: "script",
      idempotencyKey: "begin-pending",
    });
    const output = await c.recordStageOutput(SCOPE, {
      pipelineRunId: started.pipelineRunId,
      nodeKey: "script",
      idempotencyKey: "output-pending",
      artifacts: [artifact()],
    });
    const pending = await c.requestGate(SCOPE, {
      pipelineRunId: started.pipelineRunId,
      nodeKey: "script",
      idempotencyKey: "request-pending",
      gateKey: "G1",
      checkSetVersion: "v1",
      artifactHashes: [output.artifacts[0]!.sha256],
    });
    expect(pending.verificationStatus).toBe("passed");
    const projection = await c.readProjection(SCOPE, started.pipelineRunId);
    expect(projection?.nextAction).toBe("run_node");
    expect(projection?.blocker).toBeNull();
  });

  it("rejects invalid state jumps", () => {
    expect(() => assertExecutionTransition("pending", "output_ready")).toThrow(PipelineStateError);
    expect(() => assertExecutionTransition("completed", "running")).toThrow(PipelineStateError);
  });

  it("does not let a normal command bypass an unmet dependency frontier", async () => {
    const c = coordinator();
    const plan = testPlan();
    const started = await c.startCompiledPipeline(SCOPE, plan, {
      projectId: "VID-DAG",
      planKey: plan.pipelineKey,
      factsSnapshotHash: FACTS,
      budgetGrantId: null,
      expectedProjectRevision: 0,
      idempotencyKey: "start-dag",
      createdBy: "test",
      sourceSystem: "unit",
      sourceRunId: "run-dag",
    });
    await expect(c.beginStage(SCOPE, {
      pipelineRunId: started.pipelineRunId,
      nodeKey: "post",
      idempotencyKey: "post-too-early",
    })).rejects.toThrow(/STAGE_DEPENDENCY_NOT_READY/);
  });

  it("requires output before completion but permits an explicitly skipped stage", async () => {
    const c = coordinator();
    const plan = testPlan();
    const started = await c.startCompiledPipeline(SCOPE, plan, {
      projectId: "VID-SKIP",
      planKey: plan.pipelineKey,
      factsSnapshotHash: FACTS,
      budgetGrantId: null,
      expectedProjectRevision: 0,
      idempotencyKey: "start-skip",
      createdBy: "test",
      sourceSystem: "unit",
      sourceRunId: "run-skip",
    });
    await c.beginStage(SCOPE, {
      pipelineRunId: started.pipelineRunId,
      nodeKey: "script",
      idempotencyKey: "begin-no-output",
    });
    await expect(c.finishStage(SCOPE, {
      pipelineRunId: started.pipelineRunId,
      nodeKey: "script",
      idempotencyKey: "finish-no-output",
      status: "completed",
    })).rejects.toThrow(/STAGE_OUTPUT_REQUIRED/);
    const skipped = await c.finishStage(SCOPE, {
      pipelineRunId: started.pipelineRunId,
      nodeKey: "script",
      idempotencyKey: "finish-skip",
      status: "completed",
      skipped: true,
    });
    expect(skipped.executionStatus).toBe("completed");
    expect(skipped.verificationStatus).toBe("not_applicable");
  });

  it("persists an explicit host interruption for crash recovery", async () => {
    const c = coordinator();
    const plan = testPlan();
    const started = await c.startCompiledPipeline(SCOPE, plan, {
      projectId: "VID-INTERRUPT",
      planKey: plan.pipelineKey,
      factsSnapshotHash: FACTS,
      budgetGrantId: null,
      expectedProjectRevision: 0,
      idempotencyKey: "start-interrupt",
      createdBy: "test",
      sourceSystem: "unit",
      sourceRunId: "run-interrupt",
    });
    await c.beginStage(SCOPE, {
      pipelineRunId: started.pipelineRunId,
      nodeKey: "script",
      idempotencyKey: "script-running",
    });
    const interrupted = await c.interruptPipeline(SCOPE, {
      pipelineRunId: started.pipelineRunId,
      expectedRevision: started.revision,
      idempotencyKey: "interrupt",
      reason: "worker connection lost",
    });
    expect(interrupted.status).toBe("interrupted");
    const projection = await c.readProjection(SCOPE, started.pipelineRunId);
    expect(projection?.stages.find(stage => stage.nodeKey === "script")?.executionStatus).toBe("interrupted");
  });
});

describe("shadow and lease boundaries", () => {
  it("uses one canonical project lease key", () => {
    expect(projectExecutionLeaseKey(SCOPE, "VID-1")).toBe(
      JSON.stringify(["project-run", "tenant-1", "workspace-1", "VID-1"]),
    );
    expect(pipelineControlStateLockKey(SCOPE, "VID-1")).not.toBe(projectExecutionLeaseKey(SCOPE, "VID-1"));
  });

  it("records a human/agent gate as output_ready evidence without executing media", async () => {
    const c = coordinator();
    const plan = compilePipeline({
      quest: "gated-film",
      name: "有门管线",
      version: "v1",
      steps: [
        { step_key: "script", name: "剧本", owner: "scriptwriter", outputs: ["script_blueprint"] },
        { step_key: "g1-script", name: "门", owner: "director", gate: "G1", outputs: ["review_report"] },
      ],
    }, {
      adapterRegistry: [{ id: "vendor-preproduction", pipelineKeys: ["gated-film"] }],
      knownGates: new Set(["G1"]),
    });
    const shadow = new PipelineShadowSession(c, {
      scope: SCOPE,
      projectId: "VID-3",
      plan,
      factsSnapshotHash: FACTS,
      sourceSystem: "legacy",
      sourceRunId: "run-3",
      createdBy: "legacy-worker",
      idempotencyKey: "shadow-3",
    });
    await shadow.start();
    await shadow.gateResolved({
      observationId: "gate-1",
      gateKey: "G1",
      decision: "passed",
      actor: "reviewer",
      checkSetVersion: "rubric-v1",
      content: "真实门产物",
    });
    const run = await shadow.runState();
    const gateStage = run.plan.steps.find(step => step.stageKey === "g1-script");
    expect(gateStage?.verify.gate).toBe("G1");
  });

  it("maps internally folded marketing gates to their real composite node", async () => {
    const c = coordinator();
    const plan = parseAndCompilePipeline(await readFile(path.join(PIPELINES, "marketing-film.yml"), "utf8"), {
      knownGates: DEFAULT_KNOWN_GATES,
    });
    const shadow = new PipelineShadowSession(c, {
      scope: SCOPE,
      projectId: "VID-4",
      plan,
      factsSnapshotHash: FACTS,
      sourceSystem: "studio-worker",
      sourceRunId: "run-4",
      createdBy: "studio-worker",
      idempotencyKey: "shadow-4",
    });
    expect(shadow.nodeForGate("G5")).toBe("production");
    expect(shadow.nodeForGate("G6")).toBe("production");
    expect(shadow.nodeForGate("G7")).toBe("production");
    expect(shadow.nodeForGate("G8")).toBe("render");
  });

  it("keeps a composite marketing stage open until G7 and lets a later rejection supersede a pass", async () => {
    const c = coordinator();
    const plan = parseAndCompilePipeline(await readFile(path.join(PIPELINES, "marketing-film.yml"), "utf8"), {
      knownGates: DEFAULT_KNOWN_GATES,
    });
    const shadow = new PipelineShadowSession(c, {
      scope: SCOPE,
      projectId: "VID-5",
      plan,
      factsSnapshotHash: FACTS,
      sourceSystem: "studio-worker",
      sourceRunId: "run-5",
      createdBy: "studio-worker",
      idempotencyKey: "shadow-5",
    });
    await shadow.gateResolved({
      observationId: "g5-pass",
      gateKey: "G5",
      decision: "passed",
      actor: "studio-worker",
      checkSetVersion: "v1",
      content: "定妆照通过",
    });
    const run = await shadow.runState();
    const afterPass = await c.readProjection(SCOPE, run.id);
    expect(afterPass?.stages.find(stage => stage.nodeKey === "production")?.executionStatus).toBe("output_ready");
    await shadow.gateResolved({
      observationId: "g7-reject",
      gateKey: "G7",
      decision: "rejected",
      actor: "studio-worker",
      checkSetVersion: "v1",
      content: "最终预生产打回",
      issues: ["最终合同不一致"],
    });
    const afterReject = await c.readProjection(SCOPE, run.id);
    const production = afterReject?.stages.find(stage => stage.nodeKey === "production");
    expect(production?.executionStatus).toBe("failed");
    expect(production?.verificationStatus).toBe("rejected");
  });
});
