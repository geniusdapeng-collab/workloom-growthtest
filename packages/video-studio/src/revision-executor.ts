/** 返工调度只调用已登记工位；每步仍须执行自己的门禁，调度成功不授予交付封签。 */
import { buildRevisionPlan, type RevisionPlan } from "./revise.js";
import { assertSelectedShotStageScope, fingerprintArtifact, type ArtifactFingerprint } from "./production-lineage.js";

export interface RevisionStepOutcome {
  /** 子管线必须把失败、缺测、未执行阶段转成非零退出码。 */
  exitCode: number | null;
  detail: string;
}
export interface RevisionExecution {
  plan: RevisionPlan;
  status: "completed" | "blocked" | "failed" | "unverified";
  steps: Array<{ step: RevisionPlan["executionSteps"][number]; outcome: RevisionStepOutcome }>;
  errors: string[];
  reused: Array<{ shotId: string; artifact: ArtifactFingerprint }>;
}

/**
 * 用实际文件重新规划；不接收调用方手写的 executable=true。
 * 选中镜头步骤与项目后期步骤分开运行，任一步失败停止；未选镜头每步前后都核对字节和 realpath。
 * onStep 必须连接既有生产入口，付费授权、阶段资格和终审由该入口校验，不能用本函数结果替代。
 */
export async function executeRevision(options: {
  note: string;
  shots: Array<{ shotId: string; clipPath: string }>;
  namedShots?: string[];
  onStep: (step: RevisionPlan["executionSteps"][number], index: number) => Promise<RevisionStepOutcome>;
}): Promise<RevisionExecution> {
  const plan = buildRevisionPlan({ ...options, hasher: (path) => fingerprintArtifact(path).sha256 });
  const report: RevisionExecution = { plan, status: "blocked", steps: [], errors: [], reused: [] };
  if (!plan.executable) {
    report.errors.push(...plan.blockers.map((blocker) => `${blocker.code}: ${blocker.detail}`));
    return report;
  }
  try {
    for (const entry of plan.reuseEvidence) {
      const artifact = fingerprintArtifact(entry.path);
      if (artifact.sha256 !== entry.sha256) throw new Error(`REVISION_REUSE_CHANGED_BEFORE_START: ${entry.shotId}`);
      report.reused.push({ shotId: entry.shotId, artifact });
    }
    const checkReuse = () => {
      for (const entry of report.reused) {
        const now = fingerprintArtifact(entry.artifact.path);
        if (now.sha256 !== entry.artifact.sha256 || now.realpath !== entry.artifact.realpath || now.bytes !== entry.artifact.bytes) {
          throw new Error(`REVISION_UNSELECTED_SHOT_CHANGED: ${entry.shotId}`);
        }
      }
    };
    for (let index = 0; index < plan.executionSteps.length; index++) {
      const original = plan.executionSteps[index]!;
      if (!original.stages.length || original.stages.includes("revise")) throw new Error("REVISION_INVALID_COMPONENT_STEP");
      assertSelectedShotStageScope(original.stages, original.scope === "selected-shots" ? original.shotIds : []);
      checkReuse();
      // Give the adapter a copy so it cannot alter the recorded plan or a subsequent step.
      const step = { ...original, stages: [...original.stages], shotIds: [...original.shotIds] };
      let outcome: RevisionStepOutcome;
      try { outcome = await options.onStep(step, index); }
      catch (error) {
        outcome = { exitCode: null, detail: error instanceof Error ? error.message : String(error) };
      }
      report.steps.push({ step: { ...original, stages: [...original.stages], shotIds: [...original.shotIds] }, outcome });
      checkReuse();
      if (outcome.exitCode !== 0) {
        report.status = outcome.exitCode === null ? "unverified" : "failed";
        report.errors.push(`REVISION_STEP_NOT_COMPLETED: ${index + 1}: ${outcome.detail}`);
        return report;
      }
    }
    report.status = "completed";
  } catch (error) {
    report.status = "unverified";
    report.errors.push(error instanceof Error ? error.message : String(error));
  }
  return report;
}
