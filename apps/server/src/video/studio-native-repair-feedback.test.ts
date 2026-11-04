import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadNativeProductionRepairEvidence, NATIVE_CAMERA_FAILURE_PREFIX } from "./studio-native-repair-feedback.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const archiveRoot = await realpath(await mkdtemp(path.join(tmpdir(), "wl-native-feedback-")));
  directories.push(archiveRoot);
  await mkdir(path.join(archiveRoot, "stages/prompt_review"), { recursive: true });
  const issues = [
    { rule: "R1_scale_jump", shots: ["S5", "S6"], message: "中景到大特写，无动机。".repeat(60), rewrite_hint: '使用真实动机；示例含括号{"说明":"不截断"}。' },
    { rule: "R4_transition_mismatch", shots: ["S5", "S6"], message: "硬切未声明合法动机。", rewrite_hint: "满足R1或调整景别跨度。" },
    { rule: "R1_scale_jump", shots: ["S6", "S7"], message: "大特写到中景，无动机。", rewrite_hint: "对照冻结动作与两侧邻镜自行修订。" },
  ];
  const message = NATIVE_CAMERA_FAILURE_PREFIX + issues.map(issue => JSON.stringify(issue)).join("；");
  const meta = { errorClass: "BUG", failedAt: "2026-11-05T00:00:30.000Z",
    stack: `StudioCheckpointError: ${message}\n    at nativeProduction (test-only.ts:1:1)` };
  const file = path.join(archiveRoot, "stages/prompt_review/attempt-13.meta.json");
  await writeFile(file, JSON.stringify(meta));
  const prior = { runId: "RUN-aabbccdd", attempt: 13, stageId: "prompt_review" as const, status: "failed",
    errorClass: "BUG", errorMessage: message.slice(0, 500), startedAt: "2026-11-05T00:00:00.000Z", finishedAt: "2026-11-05T00:01:00.000Z" };
  const input = { archiveRoot, prior, priorOutcome: { state: "known" }, inherited: null };
  return { archiveRoot, file, issues, message, meta, prior, input };
}

it("uses the existing complete failure meta rather than the500-character database excerpt", async () => {
  const f = await fixture();
  const before = await readFile(f.file);
  const result = await loadNativeProductionRepairEvidence(f.input);
  expect(f.prior.errorMessage).toHaveLength(500);
  expect(f.prior.errorMessage).not.toContain('"S6","S7"');
  expect(result?.diagnoses).toHaveLength(1);
  expect(result?.diagnoses[0]).toMatchObject({ originRunId: f.prior.runId, attempt: 13, stageId: "prompt_review",
    metaRef: "stages/prompt_review/attempt-13.meta.json", failedAt: f.meta.failedAt,
    message: f.message, issues: f.issues, metaSha256: createHash("sha256").update(before).digest("hex") });
  expect(await readFile(f.file)).toEqual(before);
  expect(result).not.toHaveProperty("approved");
});

it.each([null, { state: "unknown" }, { state: "dispatching" }, { state: "receipt_unverified" }])(
  "does not import another input or unsettled attempt without the same-task known OUTCOME: %j", async priorOutcome => {
    const f = await fixture();
    await rm(f.file);
    expect(await loadNativeProductionRepairEvidence({ ...f.input, priorOutcome })).toBeNull();
  });

it("carries original evidence unchanged through an infrastructure failure and appends a new native failure once", async () => {
  const f = await fixture();
  const first = await loadNativeProductionRepairEvidence(f.input);
  const before = structuredClone(first);
  const inherited = await loadNativeProductionRepairEvidence({ ...f.input,
    prior: { ...f.prior, runId: "RUN-bbccddee", attempt: 14, errorMessage: "provider returned HTTP500" }, inherited: first });
  expect(inherited).toEqual(before);
  expect(first).toEqual(before);
  const nextMeta = { ...f.meta, failedAt: "2026-11-05T00:02:30.000Z" };
  await writeFile(path.join(f.archiveRoot, "stages/prompt_review/attempt-14.meta.json"), JSON.stringify(nextMeta));
  const nextInput = { ...f.input, inherited, prior: { ...f.prior, runId: "RUN-bbccddee", attempt: 14,
    startedAt: "2026-11-05T00:02:00.000Z", finishedAt: "2026-11-05T00:03:00.000Z" } };
  const next = await loadNativeProductionRepairEvidence(nextInput);
  expect(next?.diagnoses.map(item => item.originRunId)).toEqual(["RUN-aabbccdd", "RUN-bbccddee"]);
  expect(next?.diagnoses[0]).toEqual(first?.diagnoses[0]);
  expect(await loadNativeProductionRepairEvidence({ ...nextInput, inherited: next })).toEqual(next);
});

it("rejects a mismatched ledger prefix, an out-of-run timestamp and a truncated complete diagnosis", async () => {
  const f = await fixture();
  await expect(loadNativeProductionRepairEvidence({ ...f.input, prior: { ...f.prior,
    errorMessage: f.prior.errorMessage.replace("中景", "远景") } })).rejects.toThrow("台账摘要不一致");
  await writeFile(f.file, JSON.stringify({ ...f.meta, failedAt: "2026-11-05T00:04:00.000Z" }));
  await expect(loadNativeProductionRepairEvidence(f.input)).rejects.toThrow("晚于原运行");
  await writeFile(f.file, JSON.stringify({ ...f.meta, stack: `StudioCheckpointError: ${f.prior.errorMessage}` }));
  await expect(loadNativeProductionRepairEvidence(f.input)).rejects.toThrow("运镜诊断被截断");
});

it("rejects missing or symlinked failure artifacts and does not read the symlink target", async () => {
  const f = await fixture();
  const target = path.join(f.archiveRoot, "external-meta.json");
  const original = await readFile(f.file);
  await writeFile(target, original);
  await rm(f.file);
  await expect(loadNativeProductionRepairEvidence(f.input)).rejects.toThrow("原失败档案读取失败");
  await symlink(target, f.file);
  await expect(loadNativeProductionRepairEvidence(f.input)).rejects.toThrow("原失败档案路径无效");
  expect(await readFile(target)).toEqual(original);
});

it("rejects changed bytes for an inherited origin and malformed inherited evidence", async () => {
  const f = await fixture();
  const first = await loadNativeProductionRepairEvidence(f.input);
  await writeFile(f.file, JSON.stringify({ ...f.meta, stack: f.meta.stack.replace("对照冻结动作", "对照新动作") }));
  await expect(loadNativeProductionRepairEvidence({ ...f.input, inherited: first })).rejects.toThrow("同一原失败的诊断字节已变化");
  await expect(loadNativeProductionRepairEvidence({ ...f.input, inherited: { ...first, schemaVersion: "untrusted" } }))
    .rejects.toThrow("继承的原生反馈格式无效");
});
