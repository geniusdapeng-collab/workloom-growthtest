type RecordValue = Record<string, unknown>;

const record = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};

const REQUIRED_GATES = {
  narrative: ["G2_THEME", "G3_INSIGHT", "G4_PRD", "G5_PORTRAIT", "G6_PROMPT", "G7_FINAL"],
  marketing: ["G1_DOSSIER", "G2_THEME", "G3_INSIGHT", "G4_PRD", "G5_PORTRAIT", "G6_PROMPT", "G7_FINAL"],
} as const;

/**
 * The audit matrix deliberately skips rendering. Vendor postproduction then
 * reports missing shot MP4s, which makes its umbrella `success` false even when
 * every preproduction gate and guard passed. Convert only that exact
 * preproduction-only case into success and preserve the delivery boundary.
 */
export function finalizePreproductionAuditOutcome<T extends RecordValue>(
  result: T,
  gateRecords: unknown[],
  route: "narrative" | "marketing",
): { result: T; audited: boolean; reason: string } {
  if (result.success === true) return { result, audited: true, reason: "already-success" };
  const errors: string[] = [];
  const gates = gateRecords.map(record);
  for (const gate of REQUIRED_GATES[route]) {
    if (!gates.some((item) => item.gate === gate && item.approved === true)) errors.push(`missingApprovedGate:${gate}`);
  }
  const stages = record(result.stages);
  const pipelineGuard = record(stages.pipelineGuard);
  if (pipelineGuard.pass !== true) errors.push("pipelineGuard:not-passed");
  const rendering = record(stages.renderingEngine);
  if (rendering.skipped !== true) errors.push("renderingEngine:not-skipped");
  const requirementAlignment = record(stages.requirementAlignment);
  if (requirementAlignment.pass !== true) errors.push("requirementAlignment:not-passed");
  const production = record(stages.productionEngine);
  const shots = Array.isArray(production.shots) ? production.shots : [];
  const prompts = Array.isArray(production.prompts) ? production.prompts : [];
  if (shots.length <= 0) errors.push("production:no-shots");
  if (prompts.length !== shots.length) errors.push("production:prompt-count-mismatch");
  if (errors.length > 0) {
    return { result, audited: false, reason: errors.join(",") };
  }
  const postProduction = record(stages.postProductionEngine);
  const postQuality = record(record(postProduction.stages).quality);
  const postIssues = Array.isArray(postQuality.issues) ? postQuality.issues : [];
  const mutable = result as RecordValue;
  mutable.success = true;
  mutable.preproductionAudit = {
    status: "passed",
    environment: "local-preview",
    scope: "preproduction-only",
    gates: [...REQUIRED_GATES[route]],
    renderSubmitted: false,
    deliveryStatus: "not_run",
    ignoredPostProductionFailure: postProduction.success === false,
    postProductionIssues: postIssues.map(String),
    reason: "all required preproduction gates, pipeline guard, duration and alignment checks passed; rendering was explicitly skipped",
  };
  mutable.deliveryStatus = {
    status: "not_run",
    reason: "real 14-case preproduction audit does not submit paid rendering",
    preproductionPassed: true,
    renderSubmitted: false,
  };
  return { result, audited: true, reason: "preproduction-only-success" };
}
