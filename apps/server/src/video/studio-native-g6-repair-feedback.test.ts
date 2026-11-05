import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadNativeProductionRepairEvidence, NATIVE_CAMERA_FAILURE_PREFIX } from "./studio-native-repair-feedback.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

async function fixture(complete = false) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "wl-g6-feedback-")));
  directories.push(root);
  const archiveRoot = path.join(root, "archive", "ws-g6", "VID-g6-unit");
  const gateWorkDir = path.join(root, "workspaces", "ws-g6");
  const gateFile = path.join(gateWorkDir, "gates", "VID-g6-unit", "prompt-review-4", "G6_PROMPT.md");
  await mkdir(path.dirname(gateFile), { recursive: true });
  await mkdir(archiveRoot, { recursive: true });
  const content = "完整逐镜提示词：原合同要求先拿起器物，再转动，最后放稳。";
  await writeFile(gateFile, content);
  const prior = { runId: "RUN-g6-prior", attempt: 4, stageId: "prompt_review" as const, status: "failed",
    errorClass: "BUG", errorMessage: "本次执行未通过完整G6提示词审核",
    startedAt: "2026-11-05T01:00:00.000Z", finishedAt: "2026-11-05T01:01:00.000Z" };
  const issues = Array.from({ length: 7 }, (_, index) => `原合同第${index + 1}项动作未完整落实。`);
  const suggestions = issues.map((_, index) => `由原生作者修正第${index + 1}项动作并重新送审。`);
  const event: Record<string, any> = { eventId: "EVT-g6-unit", tenantId: "tenant-g6", workspaceId: "ws-g6",
    objectId: "VID-g6-unit:g6_prompt", action: "prompt.confirm", createdAt: "2026-11-05T01:00:30.000Z",
    after: { gate: "G6_PROMPT", runId: prior.runId, producerMode: "review", approved: false,
      via: "llm", degraded: false, model: "judge-g6", score: 42,
      reason: "原合同要求的动作被省略，须交回作者重写。", issues: issues.slice(0, 5), suggestions: suggestions.slice(0, 5) } };
  if (complete) event.after.producerVerdict = { stage: "prompt", status: "failed", approved: false, score: 42,
    via: "llm", degraded: false, model: "judge-g6", reason: event.after.reason, issues, suggestions,
    hardFailures: [], rerun: true, ms: 10,
    evidence: [{ path: gateFile, sha256: sha(content), scope: "complete-text" }],
    receipts: [{ modelId: "judge-g6", requestHash: "a".repeat(64), responseHash: "b".repeat(64),
      responseId: "response-g6-unit", inputTokens: 100, outputTokens: 30 }] };
  const readEvents = vi.fn(async () => [structuredClone(event)]);
  const input = { archiveRoot, prior, priorOutcome: { state: "known" }, inherited: null,
    g6Review: { tenantId: "tenant-g6", workspaceId: "ws-g6", projectId: "VID-g6-unit", model: "judge-g6", gateWorkDir, readEvents } };
  return { root, gateFile, content, prior, event, issues, suggestions, readEvents, input };
}

it("loads a real legacy negative G6 event before camera/meta matching without inventing its missing verdict evidence", async () => {
  const f = await fixture(); const before = structuredClone(f.event); const bytes = await readFile(f.gateFile);
  const result = await loadNativeProductionRepairEvidence(f.input);
  expect(result?.diagnoses).toHaveLength(1);
  expect(result?.diagnoses[0]).toMatchObject({ kind: "g6-prompt-rejection", originRunId: f.prior.runId,
    attempt: 4, message: f.event.after.reason, issues: f.issues.slice(0, 5), suggestions: f.suggestions.slice(0, 5),
    reviewEventId: f.event.eventId, evidenceMode: "legacy-event" });
  expect(result?.diagnoses[0]).not.toHaveProperty("metaSha256");
  expect(result?.diagnoses[0]).not.toHaveProperty("contentSha256");
  expect(result?.diagnoses[0]).not.toHaveProperty("approved");
  expect(f.event).toEqual(before); expect(await readFile(f.gateFile)).toEqual(bytes);
  expect(f.readEvents).toHaveBeenCalledOnce();
});

it("uses every original full-verdict issue with verified complete-text bytes, retaining event and provider receipt identity", async () => {
  const f = await fixture(true);
  const result = await loadNativeProductionRepairEvidence(f.input);
  expect(result?.diagnoses[0]).toMatchObject({ evidenceMode: "complete-producer-verdict", issues: f.issues,
    suggestions: f.suggestions, reviewEvent: { after: { producerVerdict: { receipts: [{ responseId: "response-g6-unit" }] } } } });
  expect(result?.diagnoses[0]?.issues).toHaveLength(7);
  await writeFile(f.gateFile, "同一路径已换成另一正文");
  await expect(loadNativeProductionRepairEvidence(f.input)).rejects.toThrow("STUDIO_NATIVE_REPAIR_FEEDBACK_UNVERIFIED");
});

it.each(["tenant", "workspace", "project", "run", "time", "model", "unknown", "unknown-string", "verdict-unknown-string", "receipt-model", "arrays", "status", "verdict-mismatch"])(
  "rejects tampered authoritative G6 evidence: %s", async mode => {
    const f = await fixture(true);
    if (mode === "tenant") f.event.tenantId = "tenant-other";
    if (mode === "workspace") f.event.workspaceId = "ws-other";
    if (mode === "project") f.event.objectId = "VID-other:g6_prompt";
    if (mode === "run") f.event.after.runId = "RUN-other";
    if (mode === "time") f.event.createdAt = "2026-11-05T02:00:00.000Z";
    if (mode === "model") f.event.after.model = "other-judge";
    if (mode === "unknown") f.event.after.producerVerdict.unknownOutcome = true;
    if (mode === "unknown-string") f.event.after.unknownOutcome = "false";
    if (mode === "verdict-unknown-string") f.event.after.producerVerdict.unknownOutcome = "false";
    if (mode === "receipt-model") f.event.after.producerVerdict.receipts[0].modelId = "unrelated-model";
    if (mode === "arrays") f.event.after.issues = [42];
    if (mode === "status") f.event.after.producerVerdict.status = "passed";
    if (mode === "verdict-mismatch") f.event.after.producerVerdict.reason = "另一次审核的理由";
    await expect(loadNativeProductionRepairEvidence(f.input)).rejects.toThrow("STUDIO_NATIVE_REPAIR_FEEDBACK_UNVERIFIED");
  });

it("does not read a negative gate without a settled same-task OUTCOME or turn infrastructure refusal into creative feedback", async () => {
  const f = await fixture();
  for (const state of ["unknown", "dispatching", "receipt_unverified"]) {
    expect(await loadNativeProductionRepairEvidence({ ...f.input, priorOutcome: { state } })).toBeNull();
  }
  expect(f.readEvents).not.toHaveBeenCalled();
  Object.assign(f.event.after, { via: "fallback", degraded: true, reason: "已结算的审核服务暂不可用" });
  expect(await loadNativeProductionRepairEvidence(f.input)).toBeNull();
  f.readEvents.mockResolvedValue([]);
  await expect(loadNativeProductionRepairEvidence({ ...f.input,
    prior: { ...f.prior, errorMessage: "producer-rejected(G6_PROMPT · score=42)：动作缺失" } }))
    .rejects.toThrow("原G6拒绝事件缺失");
  expect(await loadNativeProductionRepairEvidence(f.input)).toBeNull();
});

it("preserves camera and G6 origins through a later infrastructure failure and rejects rewritten inherited diagnosis", async () => {
  const f = await fixture();
  const cameraMessage = NATIVE_CAMERA_FAILURE_PREFIX + JSON.stringify({ rule: "R1_scale_jump", shots: ["S1", "S2"],
    message: "无动机的景别跨度。", rewrite_hint: "按原动作合同修正景别。" });
  await mkdir(path.join(f.input.archiveRoot, "stages/prompt_review"), { recursive: true });
  await writeFile(path.join(f.input.archiveRoot, "stages/prompt_review/attempt-3.meta.json"), JSON.stringify({
    errorClass: "BUG", failedAt: "2026-11-05T00:59:30.000Z", stack: `Error: ${cameraMessage}\n at fixture (unit.ts:1:1)` }));
  const camera = await loadNativeProductionRepairEvidence({ ...f.input, g6Review: undefined, prior: { ...f.prior,
    runId: "RUN-camera-origin", attempt: 3, errorMessage: cameraMessage.slice(0, 500),
    startedAt: "2026-11-05T00:59:00.000Z", finishedAt: "2026-11-05T01:00:00.000Z" } });
  const first = await loadNativeProductionRepairEvidence({ ...f.input, inherited: camera });
  expect(first?.diagnoses.map(item => item.originRunId)).toEqual(["RUN-camera-origin", f.prior.runId]);
  expect(await loadNativeProductionRepairEvidence({ ...f.input, inherited: first })).toEqual(first);
  f.readEvents.mockResolvedValue([]);
  expect(await loadNativeProductionRepairEvidence({ ...f.input, inherited: first,
    prior: { ...f.prior, runId: "RUN-infra-next", attempt: 5, errorMessage: "provider HTTP500" } })).toEqual(first);
  const changed = structuredClone(first)!; changed.diagnoses[1]!.message = "改写的返工理由";
  await expect(loadNativeProductionRepairEvidence({ ...f.input, inherited: changed }))
    .rejects.toThrow("STUDIO_NATIVE_REPAIR_FEEDBACK_UNVERIFIED");
});
