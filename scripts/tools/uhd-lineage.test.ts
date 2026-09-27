import { describe, expect, it } from "vitest";
import { verifyUhdLineage, type UhdLineageRecord } from "./uhd-lineage.mjs";

const digest = (letter: string) => letter.repeat(64);
const runId = "run-1";
const projectId = "film-A";
const shotlistSha256 = digest("a");
const receipt = (stage: string, evidence: Record<string, unknown>, extra: Partial<UhdLineageRecord> = {}): UhdLineageRecord => ({
  stage, shotId: null, invoked: true, ok: true, degraded: false,
  runId, projectId, shotlistSha256, quality: "uhd", verdict: { approved: true }, evidence, ...extra,
});

const valid = () => ({
  records: [
    receipt("enhance", { localVerified: true, sourceSha256: digest("b"), outputSha256: digest("c") }, { shotId: "SC-01", verdict: null }),
    receipt("compose", { clipInputs: [{ shotId: "SC-01", sourceSha256: digest("b"), enhancedSha256: digest("c") }], outputSha256: digest("d") }),
    receipt("color", { inputSha256: digest("d"), outputSha256: digest("e") }),
    receipt("subtitle", { inputSha256: digest("e"), outputSha256: digest("e") }),
    receipt("bgm", { inputSha256: digest("e"), outputSha256: digest("f") }),
  ],
  projectId, runId, shotlistSha256,
  shots: [{ shotId: "SC-01", sourceSha256: digest("b"), enhancedSha256: digest("c") }],
  masterRawSha256: digest("d"),
  stages: [
    { stage: "color" as const, inputSha256: digest("d"), outputSha256: digest("e") },
    { stage: "subtitle" as const, inputSha256: digest("e"), outputSha256: digest("e") },
    { stage: "bgm" as const, inputSha256: digest("e"), outputSha256: digest("f") },
  ],
  avReport: { ok: true, outputSha256: digest("d"), clipCount: 1 },
});

describe("UHD 同轮血缘硬闸", () => {
  it("只接受当前项目、分镜、运行、逐镜和后期层首尾相接的批准回执", () => {
    expect(verifyUhdLineage(valid())).toEqual({ ok: true, errors: [] });
    const wrongRun = valid();
    wrongRun.records[0]!.runId = "previous-run";
    expect(verifyUhdLineage(wrongRun).ok).toBe(false);
    const wrongShotlist = valid();
    wrongShotlist.records[1]!.shotlistSha256 = digest("0");
    expect(verifyUhdLineage(wrongShotlist).ok).toBe(false);
    const replacedSource = valid();
    replacedSource.shots[0]!.sourceSha256 = digest("1");
    expect(verifyUhdLineage(replacedSource).ok).toBe(false);
    const rejected = valid();
    rejected.records[2]!.verdict = { approved: false };
    expect(verifyUhdLineage(rejected).ok).toBe(false);
    const brokenChain = valid();
    brokenChain.stages[2]!.inputSha256 = digest("2");
    expect(verifyUhdLineage(brokenChain).ok).toBe(false);
    const staleAv = valid();
    staleAv.avReport.outputSha256 = digest("3");
    expect(verifyUhdLineage(staleAv).ok).toBe(false);
  });
});
