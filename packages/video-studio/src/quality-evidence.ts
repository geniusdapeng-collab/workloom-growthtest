/** Quality is separate from task execution. Missing evidence never means passed. */
export type QualityStatus = "passed" | "failed" | "unverified" | "not_applicable";
export interface QualityCheck {
  id: string;
  status: QualityStatus;
  required: boolean;
  detail: string;
}
export function aggregateQuality(checks: readonly QualityCheck[], requiredIds: readonly string[] = []): QualityStatus {
  if (checks.some((c) => c.required && c.status === "failed")) return "failed";
  const ids = new Set(checks.map((c) => c.id));
  if (new Set(checks.map((c) => c.id)).size !== checks.length
      || requiredIds.some((id) => !ids.has(id))
      || checks.some((c) => c.required && c.status === "unverified")) return "unverified";
  if (checks.length === 0) return "unverified";
  return checks.every((c) => c.status === "not_applicable") ? "not_applicable" : "passed";
}
