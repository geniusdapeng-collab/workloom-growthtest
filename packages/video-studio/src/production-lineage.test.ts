import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertSelectedShotStageScope, captureLineageInputs, createLineageReceipt, fingerprintArtifact, productionHash,
  reusableLineageArtifact, stageLineageApproved, verifyLineageReceipt,
  type LineageRecord,
} from "./production-lineage.js";

describe("生产血缘检查（实际文件，非供应商回执）", () => {
  let dir: string, source: string, output: string;
  const scope = { projectId: "VID-甲", sourceHash: productionHash({ shot: "NC-01" }) };
  const recipe = { mode: "grade", intensity: 0.3 };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lineage-")); source = join(dir, "source.mp4"); output = join(dir, "output.mp4");
    writeFileSync(source, "source fixture bytes"); writeFileSync(output, "output fixture bytes");
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const make = (): LineageRecord => ({
    stage: "color", shotId: null, ok: true,
    lineage: createLineageReceipt({ ...scope, runId: "RUN-1", stage: "color", recipe, status: "passed", inputs: [source], outputs: [output] }),
  });
  const reuse = (records: LineageRecord[]) => reusableLineageArtifact({ records, scope, stage: "color", recipe, candidate: output, upstream: source });
  const approve = (records: LineageRecord[]) => stageLineageApproved({ records, projectId: scope.projectId, stage: "color", recipe, sourceHash: () => scope.sourceHash });

  it("输入、输出、配方和最新裁决一致才复用，mtime倒序不误杀", () => {
    const record = make(); utimesSync(output, new Date(0), new Date(0));
    expect(reuse([record])).toBe(true); expect(approve([record]).ok).toBe(true);
  });
  it.each(["input", "output"])("%s改变后即使新mtime和旧成功齐全也拒绝", (target) => {
    const record = make(); writeFileSync(target === "input" ? source : output, "changed fixture data");
    expect(reuse([record])).toBe(false); expect(approve([record]).ok).toBe(false);
  });
  it("最新失败覆盖旧成功，不能筛掉失败再找成功", () => {
    const old = make(), rejected = { ...make(), ok: false };
    expect(reuse([old, rejected])).toBe(false); expect(approve([old, rejected]).ok).toBe(false);
  });
  it("未验证、降级或评审打回都不批准", () => {
    for (const status of ["failed", "unverified"] as const) {
      const record = make(); record.lineage!.status = status; expect(reuse([record])).toBe(false);
    }
    expect(reuse([{ ...make(), degraded: true }])).toBe(false);
    expect(reuse([{ ...make(), verdict: { approved: false } }])).toBe(false);
  });
  it("没有血缘版本的旧成功不当作兼容通过", () => {
    expect(reuse([{ stage: "color", ok: true }])).toBe(false);
    expect(approve([]).ok).toBe(false);
  });
  it("项目和源输入隔离", () => {
    const record = make(); record.lineage!.projectId = "VID-乙"; expect(reuse([record])).toBe(false);
    record.lineage!.projectId = scope.projectId; record.lineage!.sourceHash = productionHash({ shot: "NC-02" });
    expect(reuse([record])).toBe(false);
  });
  it("UHD 增强逐镜回执同时绑定质量档和整份分镜 SHA", () => {
    const uhdScope = { projectId: "VID-甲", sourceHash: productionHash({ quality: "uhd", shotlistSha256: "a".repeat(64), shotId: "NC-01" }) };
    const uhdRecipe = { quality: "uhd", shotlistSha256: "a".repeat(64), engine: "pinned" };
    const row: LineageRecord = { stage: "enhance", shotId: "NC-01", ok: true,
      lineage: createLineageReceipt({ ...uhdScope, runId: "RUN-UHD", stage: "enhance", shotId: "NC-01",
        recipe: uhdRecipe, status: "passed", inputs: [source], outputs: [output] }) };
    const inspect = (sourceHash: string, recipe = uhdRecipe) => stageLineageApproved({ records: [row],
      projectId: uhdScope.projectId, stage: "enhance", shotIds: ["NC-01"], sourceHash: () => sourceHash, recipe });
    expect(inspect(uhdScope.sourceHash).ok).toBe(true);
    expect(inspect(productionHash({ quality: "uhd", shotlistSha256: "b".repeat(64), shotId: "NC-01" })).ok).toBe(false);
    expect(inspect(uhdScope.sourceHash, { ...uhdRecipe, quality: "hd" }).ok).toBe(false);
  });
  it("后续其它项目记录不污染当前项目", () => {
    const other = make(); other.lineage!.projectId = "VID-乙"; other.ok = false;
    expect(reuse([make(), other])).toBe(true);
  });
  it("配方变化、未登记候选和输入不相连都不得复用", () => {
    const record = make();
    expect(reusableLineageArtifact({ records: [record], scope, stage: "color", recipe: { ...recipe, intensity: 0.6 }, candidate: output, upstream: source })).toBe(false);
    expect(reusableLineageArtifact({ records: [record], scope, stage: "color", recipe, candidate: source })).toBe(false);
    const unrelated = join(dir, "other.mp4"); writeFileSync(unrelated, "another input");
    expect(reusableLineageArtifact({ records: [record], scope, stage: "color", recipe, candidate: output, upstream: unrelated })).toBe(false);
  });
  it("缺失或空文件产生未验证，失败原因留在回执", () => {
    unlinkSync(output); const absent = make();
    expect(absent.lineage!.status).toBe("unverified"); expect(absent.lineage!.errors.length).toBe(1);
    writeFileSync(output, ""); expect(make().lineage!.status).toBe("unverified");
  });
  it("符号链接换目标即使字节相同也拒绝", () => {
    const target = join(dir, "target.mp4"), alias = join(dir, "alias.mp4");
    writeFileSync(target, "output fixture bytes"); symlinkSync(output, alias);
    const receipt = createLineageReceipt({ ...scope, runId: "R", stage: "color", recipe, status: "passed", inputs: [source], outputs: [alias] });
    unlinkSync(alias); symlinkSync(target, alias);
    expect(verifyLineageReceipt(receipt, scope, recipe).ok).toBe(false);
  });
  it("明确不适用必须有理由", () => {
    const base = { ...scope, runId: "R", stage: "voice", recipe: {}, status: "not_applicable" as const, inputs: [], outputs: [] };
    expect(createLineageReceipt(base).status).toBe("unverified");
    const receipt = createLineageReceipt({ ...base, notApplicableReason: "镜头契约明确无台词" });
    expect(verifyLineageReceipt(receipt, scope, {}).ok).toBe(true);
  });
  it("工位执行中输入变更不能倒填新哈希而通过", () => {
    const snapshot = captureLineageInputs([source]);
    writeFileSync(source, "concurrently replaced input");
    const receipt = createLineageReceipt({ ...scope, runId: "R", stage: "color", recipe, status: "passed", inputs: [source], outputs: [output], inputSnapshot: snapshot });
    expect(receipt.status).toBe("unverified");
    expect(receipt.inputs).toEqual(snapshot.artifacts);
    expect(receipt.errors.join(" ")).toContain("INPUT_CHANGED_DURING_STAGE");
  });
  it("调用前缺失输入或漏拍快照不能以调用后存在冒充通过", () => {
    unlinkSync(source);
    const snapshot = captureLineageInputs([source]);
    writeFileSync(source, "created after work started");
    const receipt = createLineageReceipt({ ...scope, runId: "R", stage: "color", recipe, status: "passed", inputs: [source], outputs: [output], inputSnapshot: snapshot });
    expect(receipt.status).toBe("unverified");
    expect(receipt.errors).toContain("LINEAGE_INPUT_SNAPSHOT_INCOMPLETE");
  });
  it("评审结束后产物改变不能把新文件倒填为已审通过", () => {
    const reviewed = { path: output, sha256: fingerprintArtifact(output).sha256 };
    const base = { ...scope, runId: "R", stage: "color", recipe, status: "passed" as const, inputs: [source], outputs: [output], reviewedArtifacts: [reviewed] };
    expect(createLineageReceipt(base).status).toBe("passed");
    writeFileSync(output, "different bytes after review");
    expect(createLineageReceipt(base).errors.join(" ")).toContain("REVIEWED_ARTIFACT_CHANGED");
    expect(createLineageReceipt(base).status).toBe("unverified");
    unlinkSync(output);
    expect(createLineageReceipt(base).status).toBe("unverified");
  });
  it("不能将另一阶段或镜头的回执换绑到当前记录", () => {
    const record = make(); record.lineage!.stage = "cover";
    expect(reuse([record])).toBe(false); expect(approve([record]).ok).toBe(false);
    record.lineage!.stage = "color"; record.lineage!.shotId = "NC-01";
    expect(reuse([record])).toBe(false); expect(approve([record]).ok).toBe(false);
  });
  it("逐镜阶段每个必需镜号都要最新通过", () => {
    const row = make(); row.shotId = "NC-01"; row.lineage!.shotId = "NC-01";
    const inspect = (shotIds: Array<string | null>) => stageLineageApproved({ records: [row], projectId: scope.projectId, stage: "color", recipe, sourceHash: () => scope.sourceHash, shotIds });
    expect(inspect(["NC-01"]).ok).toBe(true);
    expect(inspect(["NC-01", "NC-02"]).ok).toBe(false);
    expect(inspect([]).ok).toBe(false); expect(inspect(["NC-01", "NC-01"]).ok).toBe(false);
  });
  it("哈希规范化顺序稳定而类型和数值严格", () => {
    expect(productionHash({ b: 2, a: 1 })).toBe(productionHash({ a: 1, b: 2 }));
    expect(productionHash([1, 2])).not.toBe(productionHash([2, 1]));
    for (const value of [undefined, NaN, Infinity, () => 1, { missing: undefined }]) expect(() => productionHash(value)).toThrow();
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic; expect(() => productionHash(cyclic)).toThrow(/CYCLIC/);
    expect(() => fingerprintArtifact(dir)).toThrow(/NON_FILE/);
  });
  it("选中镜头阶段不能夹带项目后期；独立项目步骤可以", () => {
    expect(() => assertSelectedShotStageScope(["spec", "videos", "voice"], ["NC-02"])).not.toThrow();
    expect(() => assertSelectedShotStageScope(["bgm", "mux", "master", "deliver"], [])).not.toThrow();
    for (const stage of ["compose", "master", "deliver", "revise"]) expect(() => assertSelectedShotStageScope([stage], ["NC-02"])).toThrow(/SELECTED_SHOTS_POST_SCOPE/);
  });
});
