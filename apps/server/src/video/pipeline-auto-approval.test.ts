import { describe, expect, it } from "vitest";
import {
  compilePipeline,
  pipelineSha256,
  type ArtifactVersion,
  type GateAutoApprovalInput,
  type PipelineRun,
  type StageRun,
} from "@hyperreality/video-studio";
import { validatePipelineGateAutoApproval } from "./pipeline-control-plane.js";

const FACTS = "a".repeat(64);

function fixture(options: { gate?: string; role?: string; facts?: string; schema?: string } = {}): GateAutoApprovalInput {
  const gate = options.gate ?? "G1";
  const role = options.role ?? "dossier";
  const plan = compilePipeline({
    quest: "gate-proof",
    name: "门证据",
    version: "v1",
    steps: [
      { step_key: "g1-dossier", name: "档案确认", owner: "director", gate, outputs: ["dossier"] },
    ],
  }, {
    adapterRegistry: [{ id: "vendor-preproduction", pipelineKeys: ["gate-proof"] }],
    knownGates: new Set(["G1"]),
  });
  const contract = plan.steps[0]!;
  const run = {
    plan,
    factsSnapshotHash: FACTS,
  } as PipelineRun;
  const stage = {
    id: "SR-1",
    nodeKey: contract.stageKey,
    factsSnapshotHash: FACTS,
  } as StageRun;
  const sha256 = pipelineSha256({ role });
  const artifact = {
    id: "AV-1",
    pipelineRunId: "PR-1",
    stageRunId: "SR-1",
    role,
    schemaVersion: options.schema ?? contract.outputContract[0]!.schema,
    ref: `sha256/${sha256}.json`,
    sha256,
    logicalHash: sha256,
    factsSnapshotHash: options.facts ?? FACTS,
    contentType: "application/json",
    createdAt: "2026-11-01T00:00:00.000Z",
  } as ArtifactVersion;
  return {
    gateKey: "G1",
    checkSetVersion: "v1",
    artifactHashes: [sha256],
    artifactManifestHash: pipelineSha256([artifact]),
    artifacts: [artifact],
    run,
    stage,
  };
}

describe("视频控制面自动审批证据", () => {
  it("门所属阶段、当前事实快照、输出角色和 schema 同时匹配才通过", () => {
    expect(validatePipelineGateAutoApproval(fixture())).toMatchObject({ valid: true });
  });

  it.each([
    [{ role: "review_report" }, /缺少 dossier 门产物/],
    [{ facts: "b".repeat(64) }, /不是当前事实快照/],
    [{ schema: "workloom.artifact/dossier/forged" }, /schema 不符/],
  ] as const)("产物证据不足时失败关闭 %#", (patch, message) => {
    expect(validatePipelineGateAutoApproval(fixture(patch))).toMatchObject({ valid: false });
    expect(validatePipelineGateAutoApproval(fixture(patch)).reason).toMatch(message);
  });

  it("门不在当前阶段声明中时不因 gateKey 在白名单而通过", () => {
    const input = fixture();
    input.run.plan = {
      ...input.run.plan,
      steps: input.run.plan.steps.map((step) => ({ ...step, verify: { ...step.verify, gate: null } })),
    };
    expect(validatePipelineGateAutoApproval(input)).toEqual({
      valid: false,
      reason: "门 G1 未声明在阶段 g1-dossier",
    });
  });
});
