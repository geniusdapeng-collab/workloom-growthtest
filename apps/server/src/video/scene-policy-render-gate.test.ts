import { describe, expect, it } from "vitest";
import { applyScenePolicy, auditScenePolicy, type ScenePolicy, type ScenePolicyShot } from "@hyperreality/video-studio";
import { verifyScenePolicyProductionSource, type ScenePolicyProductionSource } from "./scene-policy-render-gate.js";

const policy: ScenePolicy = {
  schemaVersion: "workloom.scene-policy/v1", id: "audit-test", version: "1", title: "双镜测试片型",
  sourceSha256: "a".repeat(64), priority: 1, autoSignals: ["测试片型"], requiresPerson: false,
  primaryTags: ["wide", "person-close"], ratios: { wide: { min: 0.5 }, "person-close": { min: 0.5 } },
  tagEvidence: { wide: ["全景"], "person-close": ["特写"] }, movingEvidence: [], speechScenes: {},
  formalCostumeEvidence: [], restrictedLocations: [], qualityFloorTerms: [],
  requiredPlanCues: { 主角: ["主角"] },
  prompt: { scene: "测试片型正式场景", speech: "正式口播", visualReview: "逐镜审片",
    byTag: { wide: "广角全景", "person-close": "面部特写" } },
};

function validSource(): ScenePolicyProductionSource {
  const shots: ScenePolicyShot[] = [
    { shotId: "S-1", duration: 5, policyTags: ["wide"], scene: "明亮厅堂里主角入场", composition: "主角全景" },
    { shotId: "S-2", duration: 5, policyTags: ["person-close"], scene: "主角神态", composition: "面部特写" },
  ].map((shot) => applyScenePolicy({ ...shot, prompt: `${shot.scene}；${shot.composition}` }, policy));
  const report = auditScenePolicy({ title: "测试片型", shots }, policy);
  expect(report.passed).toBe(true);
  const decision = { id: policy.id, version: policy.version, sourceSha256: policy.sourceSha256!, reason: "测试片型明确命中", evidence: ["title:测试片型"] };
  report.policy.selection = decision.reason;
  return {
    decision, policy, projectId: "VID-1", attempt: 2, shotId: "S-1",
    output: {
      success: true, scenePolicyPassed: true,
      scenePolicyReportRef: "stages/preproduction/attempt-2.scene-policy-report.json",
      scenePolicyReportSha256: "b".repeat(64),
      shotlistRef: "stages/preproduction/attempt-2.shotlist.json",
      shotlistSha256: "c".repeat(64),
    },
    prompts: { stageId: "preproduction", attempt: 2, scenePolicy: structuredClone(decision),
      shots: shots.map((shot) => ({ shotId: shot.shotId, durationSec: shot.duration, prompt: shot.prompt })) },
    report, shotlist: { title: "测试片型", scenePolicy: structuredClone(decision), scenePolicySelection: structuredClone(decision), shots },
  };
}

describe("预生产片型证据进入供应商资格前的硬审计", () => {
  it("仅完整片单重算通过、当前知识版本和实际供应商提示词同源时放行", () => {
    expect(verifyScenePolicyProductionSource(validSource())).toMatchObject({
      policyId: "audit-test", attempt: 2, shotId: "S-1",
      reportSha256: "b".repeat(64), shotlistSha256: "c".repeat(64),
    });
  });

  it("旧 attempt、旧知识版本、未通过报告与伪造 passed 均不能签发", () => {
    const old = validSource(); old.attempt = 3;
    expect(() => verifyScenePolicyProductionSource(old)).toThrow(/本次完整片型审计/);
    const stale = validSource(); stale.decision.sourceSha256 = "d".repeat(64);
    expect(() => verifyScenePolicyProductionSource(stale)).toThrow(/知识条目不一致/);
    const wrongEvidence = validSource(); wrongEvidence.decision.evidence = ["另一个客户来源"];
    expect(() => verifyScenePolicyProductionSource(wrongEvidence)).toThrow(/政策身份不一致/);
    const rejected = validSource(); rejected.report!.passed = false;
    expect(() => verifyScenePolicyProductionSource(rejected)).toThrow(/审计报告不是当前通过/);
    const forged = validSource();
    (forged.shotlist!.shots as ScenePolicyShot[])[0]!.policyTags = ["person-close"];
    expect(() => verifyScenePolicyProductionSource(forged)).toThrow(/镜头表重算与审计报告不一致/);
  });

  it("审过的镜头号或提示词与实际预生产生成包不同时阻断", () => {
    const missing = validSource(); missing.shotId = "S-3";
    expect(() => verifyScenePolicyProductionSource(missing)).toThrow(/不在本次唯一完整片单/);
    const changed = validSource(); (changed.prompts.shots as Array<{ prompt: string }>)[0]!.prompt = "另一条未经审计的提示词";
    expect(() => verifyScenePolicyProductionSource(changed)).toThrow(/镜头\/时长\/提示词未逐一对应/);
    const noPolicyPrompt = validSource();
    const shots = noPolicyPrompt.shotlist!.shots as ScenePolicyShot[];
    shots[0]!.prompt = "明亮厅堂里主角全景";
    (noPolicyPrompt.prompts.shots as Array<{ prompt: string }>)[0]!.prompt = shots[0]!.prompt;
    expect(() => verifyScenePolicyProductionSource(noPolicyPrompt)).toThrow(/未包含片型\/景别\/口播约束/);
    const wrongDuration = validSource();
    (wrongDuration.prompts.shots as Array<{ durationSec: number }>)[0]!.durationSec = 2;
    expect(() => verifyScenePolicyProductionSource(wrongDuration)).toThrow(/镜头\/时长\/提示词未逐一对应/);
  });

  it("无片型项目可以继续旧链，但有片型残留不能以 null 决策旁路", () => {
    const unrelated = validSource();
    unrelated.decision = { id: null, version: null, sourceSha256: null, reason: "未命中", evidence: [] };
    unrelated.policy = null;
    expect(() => verifyScenePolicyProductionSource(unrelated)).toThrow(/无片型，但预生产带有片型产物/);
    unrelated.output = { success: true };
    unrelated.prompts = { stageId: "preproduction", attempt: 2, shots: [] };
    unrelated.report = null; unrelated.shotlist = null;
    expect(verifyScenePolicyProductionSource(unrelated)).toBeNull();
    unrelated.output.scenePolicyReportSha256 = "b".repeat(64);
    expect(() => verifyScenePolicyProductionSource(unrelated)).toThrow(/无片型，但预生产带有片型产物/);
  });
});
