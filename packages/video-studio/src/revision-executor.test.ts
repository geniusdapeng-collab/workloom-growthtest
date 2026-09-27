import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeRevision } from "./revision-executor.js";

describe("返工调用工位与未选镜头保护", () => {
  let dir: string;
  let shots: Array<{ shotId: string; clipPath: string }>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "revision-executor-"));
    shots = ["NC-01", "NC-02", "GR-03"].map((shotId) => ({ shotId, clipPath: join(dir, `${shotId}.mp4`) }));
    for (const shot of shots) writeFileSync(shot.clipPath, `${shot.shotId}: media fixture`);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  it("改音乐只调后期闭包，没有生成镜头调用", async () => {
    const onStep = vi.fn(async () => ({ exitCode: 0, detail: "工位退出成功" }));
    const report = await executeRevision({ note: "配乐换成更轻的器乐", shots, onStep });
    expect(report.status).toBe("completed");
    expect(onStep).toHaveBeenCalledOnce();
    expect(report.steps[0]!.step).toEqual({ scope: "project", shotIds: ["NC-01", "NC-02", "GR-03"], stages: ["bgm", "mux", "master", "deliver"] });
    expect(report.reused).toHaveLength(3);
  });
  it("改一镜仅该镜走生成，再按完整项目范围后期", async () => {
    const calls: string[][] = [];
    const report = await executeRevision({ note: "NC-02 画面穿帮，需要重拍", shots, onStep: async (step) => {
      calls.push([...step.shotIds]);
      if (step.scope === "selected-shots") writeFileSync(shots[1]!.clipPath, "fixed selected shot");
      return { exitCode: 0, detail: "组件调用完成" };
    } });
    expect(report.status).toBe("completed");
    expect(calls).toEqual([["NC-02"], ["NC-01", "NC-02", "GR-03"]]);
    expect(report.reused.map((entry) => entry.shotId)).toEqual(["NC-01", "GR-03"]);
    expect(report.plan.requiresRenderSubmitGate).toBe(true);
  });
  it.each(["更好看一点", "重拍 XX-99", "NC-02 重拍，顺便更高级一点"])("意见不可执行时不调用任何工位：%s", async (note) => {
    const onStep = vi.fn();
    const report = await executeRevision({ note, shots, onStep });
    expect(report.status).toBe("blocked"); expect(onStep).not.toHaveBeenCalled();
  });
  it("缺失复用文件在调用前阻断", async () => {
    unlinkSync(shots[0]!.clipPath); const onStep = vi.fn();
    const report = await executeRevision({ note: "NC-02 重拍", shots, onStep });
    expect(report.status).toBe("blocked"); expect(onStep).not.toHaveBeenCalled();
  });
  it.each([6, null])("子管线失败或进程未知(%s)即停，不执行后期", async (exitCode) => {
    const onStep = vi.fn(async () => ({ exitCode, detail: "模拟明确失败或信号中断" }));
    const report = await executeRevision({ note: "NC-02 重拍", shots, onStep });
    expect(report.status).toBe(exitCode === null ? "unverified" : "failed");
    expect(onStep).toHaveBeenCalledOnce(); expect(report.steps).toHaveLength(1);
  });
  it("调用异常保留错误且不伪造完成", async () => {
    const report = await executeRevision({ note: "NC-02 重拍", shots, onStep: async () => { throw new Error("cannot launch component"); } });
    expect(report.status).toBe("unverified"); expect(report.errors.join(" ")).toContain("cannot launch");
  });
  it("工位错误修改未选镜头，即使退出0也不得继续", async () => {
    const onStep = vi.fn(async () => {
      writeFileSync(shots[0]!.clipPath, "illegal unrelated rewrite");
      return { exitCode: 0, detail: "错误工位" };
    });
    const report = await executeRevision({ note: "NC-02 重拍", shots, onStep });
    expect(report.status).toBe("unverified"); expect(report.errors.join(" ")).toContain("UNSELECTED_SHOT_CHANGED: NC-01");
    expect(onStep).toHaveBeenCalledOnce();
  });
  it("未选镜头符号链接换目标，即使同字节也拒绝", async () => {
    const original = shots[0]!.clipPath, alias = join(dir, "alias.mp4"), other = join(dir, "other.mp4");
    symlinkSync(original, alias); writeFileSync(other, "NC-01: media fixture"); shots[0]!.clipPath = alias;
    const report = await executeRevision({ note: "NC-02 重拍", shots, onStep: async () => {
      unlinkSync(alias); symlinkSync(other, alias); return { exitCode: 0, detail: "换绑定" };
    } });
    expect(report.status).toBe("unverified");
  });
  it("适配器不能通过修改传入步骤缩掉后期范围或污染报告", async () => {
    const report = await executeRevision({ note: "NC-02 重拍", shots, onStep: async (step) => {
      step.shotIds.length = 0; step.stages.push("revise"); return { exitCode: 0, detail: "complete" };
    } });
    expect(report.status).toBe("completed");
    expect(report.steps[1]!.step.shotIds).toEqual(["NC-01", "NC-02", "GR-03"]);
    expect(report.plan.stages).not.toContain("revise");
  });
});
