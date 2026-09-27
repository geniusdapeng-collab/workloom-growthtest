import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scene = { shotId: "空镜-一", scene: "无人湖面空镜", lighting: "阴天散射天光", depth_of_field: "深景深", environmentProfile: { setting: "exterior", condition: "natural" } };
function run(payload: unknown, extra: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "environment-cli-")); dirs.push(dir);
  const path = join(dir, "shots with space.json"); writeFileSync(path, typeof payload === "string" ? payload : JSON.stringify(payload));
  const result = spawnSync(process.execPath, ["--import", "tsx", resolve("scripts/tools/environment-realism-audit.mts"), "--shots", path, "--json", ...extra], { encoding: "utf8", timeout: 30_000 });
  return { ...result, dir, path, report: result.stdout.trim() ? JSON.parse(result.stdout) : null };
}
describe("environment audit real CLI", () => {
  it("无人外景可核实、设备不适用；支持中文ID和空格路径", () => {
    const result = run({ projectId: "海边", shots: [scene] });
    expect(result.status, result.stderr).toBe(0); expect(result.report).toMatchObject({ status: "passed", qualified: true, renderBlocked: false, devicePolicy: { status: "not_applicable" } });
    expect(result.report.perShot[0].sourceHash).toMatch(/^[a-f0-9]{64}$/); expect(JSON.parse(readFileSync(join(result.dir, "env-realism-report.json"), "utf8"))).toEqual(result.report);
  });
  it("顶层冻结年代继承，未来设备失败，缺时代未验证", () => {
    const phone = { ...scene, scene: "手机产品特写", props: "拉丝不锈钢", lighting: "柔光箱", environmentProfile: { setting: "product", condition: "new" }, devices: [{ category: "phone", model: "iPhone 16" }] };
    expect(run({ eraProfile: { storyDate: "2024-09-20" }, shots: [phone] }).report.status).toBe("passed");
    const future = run({ eraProfile: { storyDate: "2012-01-01" }, shots: [phone] }); expect(future.status).toBe(1); expect(future.report.status).toBe("failed");
    const missing = run({ shots: [phone] }); expect(missing.status).toBe(1); expect(missing.report.status).toBe("unverified");
  });
  it("第二空间独立展开，不借用主空间家具光源或磨损；源文件不改写", () => {
    const bible = { spaceId: "office", space: { city: "上海", building: "办公室" }, materials: [{ item: "桌", material: "胡桃木" }], practicalLights: [{ type: "台灯", kelvin: 3000 }], traces: ["杯痕"], otherSpaces: [{ spaceId: "lake", city: "杭州", building: "西湖", materials: [], practicalLights: [{ type: "阴天天光" }], traces: [], environmentProfile: { setting: "exterior", condition: "natural" } }] };
    const payload = { sceneBible: bible, shots: [{ shotId: "LAKE", sceneId: "lake", scene: "无人湖面", depth_of_field: "深景深" }] };
    const result = run(payload, ["--expand"]); expect(result.status, result.stderr).toBe(0); expect(result.report.status).toBe("passed"); expect(JSON.parse(readFileSync(result.path, "utf8"))).toEqual(payload);
    const missing = run({ sceneBible: bible, shots: [{ ...scene, sceneId: "unknown" }] }, ["--expand"]); expect(missing.status).toBe(1); expect(missing.report.qualified).toBe(false);
  });
  it("无磨损不能伪装used痕迹；无手机不触发设备；soft被接受仍不提升状态", () => {
    const used = run({ shots: [{ ...scene, props: "胡桃木与玻璃，无划痕，无磨损", environmentProfile: { setting: "interior", condition: "used" } }] }); expect(used.status).toBe(1);
    expect(run({ shots: [{ ...scene, scene: "无人海滩，无手机" }] }).report.devicePolicy.status).toBe("not_applicable");
    const soft = run({ shots: [{ shotId: "ONE", scene: "空镜" }] }, ["--accept-soft"]); expect(soft.status).toBe(0); expect(soft.report.status).toBe("unverified"); expect(soft.report.qualified).toBe(false);
  });
  it.each(["{invalid", null, [], {}, { shots: [] }, { shots: [null] }, { shots: [{ scene: "空镜" }] }, { shots: [scene, scene] }, { shots: [scene], sceneBible: null }, { shots: [scene], sceneBible: { space: null } }, { shots: [scene], eraProfile: { storyDate: "2024-02-30" } }])("非法输入以exit2诊断且不输出崩溃堆栈：%j", (payload) => {
    const result = run(payload); expect(result.status).toBe(2); expect(result.stderr).toContain("环境审计输入/文件错误"); expect(result.stderr).not.toMatch(/at main|TypeError/);
  });
  it("I/O失败与缺参可诊断，报告不得覆盖原输入或其符号链接", () => {
    const output = run({ shots: [scene] }, ["--report", "/nonexistent/environment/report.json"]); expect(output.status).toBe(2);
    const input = run({ shots: [scene] });
    const invoke = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", resolve("scripts/tools/environment-realism-audit.mts"), ...args], { encoding: "utf8" });
    expect(invoke([]).status).toBe(2); expect(invoke(["--shots", "/missing/shots.json"]).status).toBe(2);
    const alias = join(input.dir, "alias.json"); symlinkSync(input.path, alias);
    for (const report of [input.path, alias]) expect(invoke(["--shots", input.path, "--report", report]).status).toBe(2);
    expect(JSON.parse(readFileSync(input.path, "utf8"))).toEqual({ shots: [scene] });
  });
});
