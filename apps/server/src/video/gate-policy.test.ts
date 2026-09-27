import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GATE_PRODUCER_STAGE, portraitGateEvidence, gateDeterministicChecks } from "./gate-policy.js";
let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "portrait-proof-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function fixture() {
  const root = path.join(dir, "characters", "P1"); mkdirSync(root, { recursive: true });
  const files: Record<string, string> = {};
  for (const angle of ["front", "threeQuarter", "closeup", "side"]) {
    files[angle] = path.join(root, `${angle}.png`); writeFileSync(files[angle]!, Buffer.from([137,80,78,71,13,10,26,10,1,2]));
  }
  const index = { schemaVersion: "workloom.portrait-index/v1", projectId: "P1", characters: { c1: { kind: "character", id: "c1", files } }, products: {} };
  const indexPath = path.join(root, "portrait-index.json"); writeFileSync(indexPath, JSON.stringify(index));
  const input = { workDir: dir, projectId: "P1", stage: { status: "completed", characters: 1, products: 0, completedPortraits: 4, pendingPortraits: 0 }, scriptReport: { characters_count: 1 } };
  return { root, files, index, indexPath, input };
}
describe("服务预生产 G5/G7", () => {
  it("G7 是文字预生产收口，不错误调用要求成片和听音回执的 master", () => expect(GATE_PRODUCER_STAGE.G7_FINAL).toBe("prompt"));
  it("只把实际读取的本项目四角度图片送审", () => {
    const f = fixture(); const evidence = portraitGateEvidence(f.input);
    expect(evidence.notApplicable).toBe(false); expect(evidence.deterministic.every(item => item.pass)).toBe(true);
    expect(evidence.artifacts.filter(item => item.kind === "image").map(item => item.path)).toEqual(Object.values(f.files).map(file => realpathSync(file)));
  });
  it.each(["missing-angle", "empty", "other-project", "escape", "symlink", "pending", "count"])("%s 证据失败关闭", kind => {
    const f = fixture();
    if (kind === "missing-angle") delete f.index.characters.c1.files.side;
    if (kind === "empty") writeFileSync(f.files.front!, "");
    if (kind === "other-project") f.index.projectId = "P2";
    if (kind === "escape") { f.index.characters.c1.files.front = path.join(dir, "outside.png"); writeFileSync(f.index.characters.c1.files.front, "image"); }
    if (kind === "symlink") { rmSync(f.files.front!); symlinkSync(f.files.side!, f.files.front!); }
    if (kind === "pending") f.input.stage.pendingPortraits = 1;
    if (kind === "count") f.input.stage.characters = 2;
    writeFileSync(f.indexPath, JSON.stringify(f.index));
    const result = portraitGateEvidence(f.input);
    expect(result.notApplicable).toBe(false); expect(result.deterministic.some(item => item.hard && !item.pass)).toBe(true);
    expect(result.artifacts).toEqual([]);
  });
  it("不适用需要本次明确无任务及剧本角色数零；空图本身不构成 N/A", () => {
    expect(portraitGateEvidence({ workDir: dir, projectId: "P1", stage: {}, scriptReport: {} }).notApplicable).toBe(false);
    const input = { workDir: dir, projectId: "P1", stage: { status: "skipped", reason: "no-characters-or-products" }, scriptReport: { characters_count: 0 } };
    expect(portraitGateEvidence(input)).toMatchObject({ notApplicable: true, deterministic: [{ status: "not_applicable" }] });
    expect(portraitGateEvidence({ ...input, scriptReport: { characters_count: 1 } }).notApplicable).toBe(false);
  });
});

it("营销G1允许合法JSON空值，拒绝仅摘要或旧自报档案", () => {
  const good = { facts: { schemaVersion: "workloom.marketing-facts/v1", stages: [1, 2, 3], sources: [1], optional: null } };
  expect(gateDeterministicChecks("G1_DOSSIER", JSON.stringify(good)).every(check => check.pass)).toBe(true);
  for (const bad of ["商品事实摘要".repeat(100), JSON.stringify({ ...good, facts: { ...good.facts, stages: [1] } }), "null"]) expect(gateDeterministicChecks("G1_DOSSIER", bad).some(check => check.hard && !check.pass)).toBe(true);
});
