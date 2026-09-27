import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRevisionPlan, buildRevisionReport, classifyRevision, type RevisionPlan } from "./revise.js";

const shots = ["NC-01", "CF-02", "GR-03"].map((shotId) => ({ shotId, clipPath: `/clips/${shotId}.mp4` }));
const hasher = (path: string) => createHash("sha256").update(path).digest("hex");
const planFor = (note: string, overrides: Partial<Parameters<typeof buildRevisionPlan>[0]> = {}) =>
  buildRevisionPlan({ note, shots, hasher, ...overrides });
function expectBlocked(plan: RevisionPlan, code: string): void {
  expect(plan.executable).toBe(false);
  expect(plan.blockers.map((entry) => entry.code)).toContain(code);
  expect(plan.rerunShots).toEqual([]);
  expect(plan.layers).toEqual([]);
  expect(plan.stages).toEqual([]);
  expect(plan.executionSteps).toEqual([]);
  expect(buildRevisionReport(plan, "意见").gate.approved).toBe(false);
}
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("后期归因不扩成视频重生成", () => {
  it.each([
    ["换一下配乐", "layer-level"], ["配乐再轻一点", "layer-level"],
    ["字幕改个错字", "layer-level"], ["NC-01 字幕写错了", "layer-level"],
    ["替换 NC-01 的字幕", "layer-level"], ["NC-01 换掉配乐", "layer-level"],
    ["封面人物替换", "layer-level"], ["更换封面人物", "layer-level"],
    ["调整镜头顺序", "layer-level"], ["不重拍，只改字幕", "layer-level"],
    ["NC-01 手指畸变", "shot-level"], ["换 NC-01", "shot-level"],
    ["NC-01 换掉", "shot-level"], ["NC-01 重拍且配乐换一下", "mixed"],
    ["NC-01 人物畸变，封面标题换一下", "mixed"],
    ["整体更高级一点", "unclassified"], ["", "unclassified"],
  ] as const)("%s → %s", (note, kind) => { expect(classifyRevision(note)).toBe(kind); });

  it.each([
    ["配乐换一下", ["bgm", "mux", "master", "deliver"]],
    ["改字幕", ["subtitle", "danmaku", "bgm", "mux", "master", "deliver"]],
    ["封面换一下", ["cover", "mux", "master", "deliver"]],
    ["调色偏暖", ["color", "subtitle", "danmaku", "bgm", "cover", "mux", "master", "deliver"]],
    ["改转场", ["compose", "color", "subtitle", "danmaku", "bgm", "cover", "mux", "master", "deliver"]],
    ["重新导出", ["deliver"]],
  ])("%s 包含必需的下游重新验收", (note, layers) => {
    const plan = planFor(note as string);
    expect(plan.executable).toBe(true);
    expect(plan.layers).toEqual(layers);
    expect(plan.rerunShots).toEqual([]);
    expect(plan.executionSteps).toEqual([{ scope: "project", shotIds: shots.map((shot) => shot.shotId), stages: layers }]);
    expect(plan.reuseEvidence).toHaveLength(3);
    const report = buildRevisionReport(plan, note as string, "2026-09-27T00:00:00Z");
    expect(report.gate.approved).toBe(true);
    expect(report.renderSubmitApproval).toEqual({ stepKey: "g8-render-submit", required: false, status: "not_applicable" });
    expect(report.generatedAt).toBe("2026-09-27T00:00:00Z");
  });
});

describe("登记镜号限定重生成范围，后期仍处理完整项目", () => {
  it("NC/CF/GR 都能点名，层意见中的镜号不会成为画面重生成目标", () => {
    const plan = planFor("NC-01 字幕错了，CF-02 人物畸变，GR-03 封面换标题");
    expect(plan.executable).toBe(true);
    expect(plan.kind).toBe("mixed");
    expect(plan.rerunShots).toEqual(["CF-02"]);
    expect(plan.reuseEvidence.map((entry) => entry.shotId)).toEqual(["NC-01", "GR-03"]);
    expect(plan.executionSteps[0]).toEqual({ scope: "selected-shots", shotIds: ["CF-02"], stages: ["cine-kb", "continuity", "micromotion", "spec", "plates", "material-gen", "videos", "voice"] });
    expect(plan.executionSteps[1]).toEqual({ scope: "project", shotIds: ["NC-01", "CF-02", "GR-03"], stages: ["compose", "color", "subtitle", "danmaku", "bgm", "cover", "mux", "master", "deliver"] });
    const report = buildRevisionReport(plan, "意见");
    expect(report.executable).toBe(true);
    expect(report.gate.approved).toBe(false);
    expect(report.renderSubmitApproval.status).toBe("unverified");
    expect(report.renderSubmitApproval.required).toBe(true);
  });

  it("Unicode 连字符、大小写、NFKC、重复引用映射回原登记编号", () => {
    const plan = planFor("ｎｃ－０１ 和 cf–02 重拍，NC-01 重渲", { namedShots: ["CF-02", "nc‑01"] });
    expect(plan.executable).toBe(true);
    expect(plan.rerunShots).toEqual(["NC-01", "CF-02"]);
  });

  it("自定义镜号和正则特殊字符按字面匹配", () => {
    const custom = [{ shotId: "旅拍[开场].v2", clipPath: "/开场.mp4" }, { shotId: "另一个", clipPath: "/其他.mp4" }];
    const plan = planFor("旅拍[开场].v2 重拍", { shots: custom });
    expect(plan.executable).toBe(true);
    expect(plan.rerunShots).toEqual(["旅拍[开场].v2"]);
  });

  it.each(["不要改全部镜头，NC-01 重拍", "全部镜头保持原样，但是 NC-01 重拍", "不要全部重拍，NC-01 人物畸变"])("否定全片不能扩大范围：%s", (note) => {
    expect(planFor(note).rerunShots).toEqual(["NC-01"]);
  });

  it("只有明确全片画面意见才选中全部镜头", () => {
    expect(planFor("所有镜头人物都僵硬，需要重拍").rerunShots).toEqual(shots.map((shot) => shot.shotId));
    expect(planFor("所有镜头，重拍").rerunShots).toEqual(shots.map((shot) => shot.shotId));
    expectBlocked(planFor("人物动作僵硬，需要重拍"), "shot_scope_required");
  });

  it("独立镜号分句提供范围；BGM 的全片要求不扩大单镜返修", () => {
    expect(planFor("NC-01，重拍").rerunShots).toEqual(["NC-01"]);
    expect(planFor("NC-01 重拍，全片的画面配乐换一下").rerunShots).toEqual(["NC-01"]);
  });

  it.each(["NC-99 重拍", "nc-999 字幕换一下", "NC-010 重拍", "NC-01 重拍，SC-88 字幕调整"])("未知编号停止计划：%s", (note) => {
    expectBlocked(planFor(note), "unknown_shot");
  });
  it("显式参数的未知编号同样停止", () => { expectBlocked(planFor("人物畸变重拍", { namedShots: ["NC-99"] }), "unknown_shot"); });
  it.each(["", "整体高级一点", "保持全部镜头原样"])("未归因意见停止：%s", (note) => { expectBlocked(planFor(note), "unclassified"); });
  it("混合意见里未知的部分不能被静默丢弃", () => {
    expectBlocked(planFor("改字幕，整体高级一点"), "unclassified");
    expect(planFor("第3条字幕错字，改一下").executable).toBe(true);
  });
});

describe("复用证据、错误路径与可重复执行", () => {
  it.each([
    [], [{ shotId: "", clipPath: "/x.mp4" }], [{ shotId: "NC-01", clipPath: "" }],
    [{ shotId: "NC-01", clipPath: "/x.mp4" }, { shotId: "nc–01", clipPath: "/y.mp4" }],
  ].map((registry) => ({ registry })))("空/缺失/归一化重复登记不生成执行步骤", ({ registry }) => { expectBlocked(planFor("改字幕", { shots: registry }), "invalid_shot_registry"); });

  it.each(["missing", "", "g".repeat(64), "a".repeat(63), "a".repeat(65)])("无效哈希 %s 停止", (hash) => {
    expectBlocked(planFor("改配乐", { hasher: () => hash }), "reuse_evidence_unavailable");
  });
  it("哈希读取异常保留失败原因，不生成部分执行步骤", () => {
    const plan = planFor("NC-01 重拍", { hasher: (path) => { if (path.includes("CF-02")) throw new Error("读取权限不足"); return hasher(path); } });
    expectBlocked(plan, "reuse_evidence_unavailable");
    expect(plan.rationale).toContain("读取权限不足");
  });
  it("真实文件哈希与缺失文件失败路径", () => {
    const root = mkdtempSync(join(tmpdir(), "revision-proof-")); roots.push(root);
    const path = join(root, "素材 中文.mp4"); writeFileSync(path, "immutable raw video bytes");
    const registry = [{ shotId: "NC-01", clipPath: path }];
    const diskHasher = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
    const plan = planFor("换配乐", { shots: registry, hasher: diskHasher });
    expect(plan.executable).toBe(true);
    expect(plan.reuseEvidence[0]?.sha256).toBe(diskHasher(path));
    rmSync(path);
    expectBlocked(planFor("换配乐", { shots: registry, hasher: diskHasher }), "reuse_evidence_unavailable");
  });
  it("仅核实复用文件；不可变输入的重复规划独立且确定", () => {
    const frozen = Object.freeze(shots.map((shot) => Object.freeze({ ...shot }))) as unknown as typeof shots;
    const spy = vi.fn(hasher);
    const one = planFor("CF-02 重拍", { shots: frozen, hasher: spy });
    expect(spy.mock.calls.map(([path]) => path)).toEqual(["/clips/NC-01.mp4", "/clips/GR-03.mp4"]);
    const two = planFor("CF-02 重拍", { shots: frozen });
    expect(two).toEqual(one);
    one.executionSteps[1]!.shotIds.pop();
    expect(two.executionSteps[1]!.shotIds).toHaveLength(3);
    expect(frozen).toHaveLength(3);
  });
});
