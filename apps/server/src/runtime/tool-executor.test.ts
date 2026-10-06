/**
 * 多桥执行器注册表回归（GR-15）。
 * 重点守一条真机缺陷（2026-09-28 生产态验收）：桥缓存必须**按作用域分桶**——
 * 否则第二个工作区会复用第一个工作区的 tenantId 绑定，被工位以 tenant_mismatch 拒绝。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeToolCoverage, loadDeploymentToolExecutor, parseBridgeSpecs, resetToolExecutorCache, toolMatchesPattern } from "./tool-executor.js";

function writeBridgeModule(): string {
  const dir = mkdtempSync(join(tmpdir(), "wl-bridge-"));
  const file = join(dir, "executor.mjs");
  writeFileSync(file, `
export const TOOL_PATTERNS = ["demo.*"];
export function createDemoExecutor(cfg) {
  return async (name, params) => ({
    result: { state: "ok", tenant: cfg.tenantId, name, params },
    receipt: { synced: true },
  });
}
`);
  return file;
}

let initialModules: string | undefined;
let initialLegacy: string | undefined;
beforeEach(() => {
  initialModules = process.env.WORKLOOM_TOOL_EXECUTOR_MODULES;
  initialLegacy = process.env.WORKLOOM_TOOL_EXECUTOR_MODULE;
  delete process.env.WORKLOOM_TOOL_EXECUTOR_MODULES;
  delete process.env.WORKLOOM_TOOL_EXECUTOR_MODULE;
  resetToolExecutorCache();
});

afterEach(() => {
  if (initialModules === undefined) delete process.env.WORKLOOM_TOOL_EXECUTOR_MODULES;
  else process.env.WORKLOOM_TOOL_EXECUTOR_MODULES = initialModules;
  if (initialLegacy === undefined) delete process.env.WORKLOOM_TOOL_EXECUTOR_MODULE;
  else process.env.WORKLOOM_TOOL_EXECUTOR_MODULE = initialLegacy;
  resetToolExecutorCache();
});

describe("多桥执行器注册表（GR-15）", () => {
  it("规格解析支持 :: 分隔（Node --env-file 会把 # 当注释截断）", () => {
    const specs = parseBridgeSpecs("/tmp/a.ts::createA::visualwrite.*|visualread.*::http://127.0.0.1:9773");
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      modulePath: "/tmp/a.ts", factoryName: "createA",
      patterns: ["visualwrite.*", "visualread.*"], baseUrlOverride: "http://127.0.0.1:9773",
    });
  });

  it("工具名模式匹配：精确名 / 前缀通配", () => {
    expect(toolMatchesPattern("visualwrite.generate", "visualwrite.*")).toBe(true);
    expect(toolMatchesPattern("visualwrite.generate", "visualread.*")).toBe(false);
    expect(toolMatchesPattern("pms.price.write", "pms.price.write")).toBe(true);
  });

  it("桥缓存按作用域分桶：两个工作区各自绑定自己的 tenantId", async () => {
    const file = writeBridgeModule();
    process.env.WORKLOOM_TOOL_EXECUTOR_MODULES = `${file}::createDemoExecutor::demo.*`;
    const wsA = { tenantId: "tenant-a", workspaceId: "ws-a" };
    const wsB = { tenantId: "tenant-b", workspaceId: "ws-b" };
    const execA = await loadDeploymentToolExecutor(wsA);
    const execB = await loadDeploymentToolExecutor(wsB);
    expect(execA).toBeTruthy();
    expect(execB).toBeTruthy();
    const [outA, outB] = await Promise.all([execA!("demo.run", {}), execB!("demo.run", {})]);
    expect((outA.result as { tenant: string }).tenant).toBe("ws-a");
    expect((outB.result as { tenant: string }).tenant).toBe("ws-b");
  });

  it("无桥覆盖的工具 → connector-required（未核实语义，不伪造回执）", async () => {
    const file = writeBridgeModule();
    process.env.WORKLOOM_TOOL_EXECUTOR_MODULES = `${file}::createDemoExecutor::demo.*`;
    const executor = await loadDeploymentToolExecutor({ tenantId: "t", workspaceId: "ws" });
    expect(executor?.supportsTool?.("demo.run")).toBe(true);
    expect(executor?.supportsTool?.("other.tool")).toBe(false);
    const out = await executor!("other.tool", {});
    expect(out.receipt.synced).toBe(false);
    expect(out.result).toMatchObject({ state: "connector-required", reason: "no-connector-for-tool" });
    const coverage = await describeToolCoverage({ tenantId: "t", workspaceId: "ws" }, ["demo.run", "other.tool"]);
    expect(coverage.covered).toEqual(["demo.run"]);
    expect(coverage.uncovered).toEqual(["other.tool"]);
  });

  it("未配置桥 → undefined（调用方保持底座兜底语义）", async () => {
    delete process.env.WORKLOOM_TOOL_EXECUTOR_MODULES;
    resetToolExecutorCache();
    expect(await loadDeploymentToolExecutor({ tenantId: "t", workspaceId: "ws" })).toBeUndefined();
  });
});

describe("MC-006：配置失败仍保留声明范围，不能成为模拟放行", () => {
  const scope = { tenantId: "t", workspaceId: "ws" };

  it("已配置但加载失败的桥保留覆盖，其它工具仍可辨别为未覆盖", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "wl-bridge-missing-")), "missing.mjs");
    process.env.WORKLOOM_TOOL_EXECUTOR_MODULES = `${file}::createDemoExecutor::demo.*`;
    const executor = await loadDeploymentToolExecutor(scope);
    expect(executor?.supportsTool?.("demo.run")).toBe(true);
    expect(executor?.supportsTool?.("other.tool")).toBe(false);
    const out = await executor!("demo.run", {});
    expect(out).toMatchObject({ result: { state: "connector-required", reason: "connector-load-failed" }, receipt: { synced: false, mode: "real" } });
    expect(await describeToolCoverage(scope, ["demo.run", "other.tool"])).toEqual({
      covered: [], uncovered: [], bridges: 0,
    });
  });

  it("工厂缺失时仍使用已读取到的模块工具声明保留失败范围", async () => {
    const file = writeBridgeModule();
    process.env.WORKLOOM_TOOL_EXECUTOR_MODULES = `${file}::notExported`;
    const executor = await loadDeploymentToolExecutor(scope);
    expect(executor?.supportsTool?.("demo.run")).toBe(true);
    expect(executor?.supportsTool?.("other.tool")).toBe(false);
    expect((await executor!("demo.run", {})).receipt).toMatchObject({ synced: false, mode: "real" });
  });

  it("工厂拒绝装配时保留规格模式，未知模式的失败桥保守接管所有工具", async () => {
    const file = writeBridgeModule();
    writeFileSync(file, "export function createToolExecutor() { return undefined; }\n");
    process.env.WORKLOOM_TOOL_EXECUTOR_MODULES = file;
    const executor = await loadDeploymentToolExecutor(scope);
    expect(executor?.supportsTool?.("anything.run")).toBe(true);
    expect((await executor!("anything.run", {})).receipt).toMatchObject({ synced: false, mode: "real" });
  });

  it("非空配置无法解析为任何模块时仍停线，不退化成从未配置桥", async () => {
    process.env.WORKLOOM_TOOL_EXECUTOR_MODULES = "::createDemoExecutor::demo.*";
    const executor = await loadDeploymentToolExecutor(scope);
    expect(executor?.supportsTool?.("demo.run")).toBe(true);
    expect((await executor!("demo.run", {}))).toMatchObject({
      result: { state: "connector-required", reason: "connector-load-failed" },
      receipt: { synced: false, mode: "real" },
    });
  });

  it("混合规格不能丢弃缺模块路径的工具声明", () => {
    const file = writeBridgeModule();
    const specs = parseBridgeSpecs(`::createToolExecutor::metrics.read,${file}::createDemoExecutor::demo.*`);
    expect(specs).toHaveLength(2);
    expect(specs[0]).toMatchObject({ modulePath: "", factoryName: "createToolExecutor", patterns: ["metrics.read"] });
  });

  it.each([
    ["::", false], ["::", true], ["#", false], ["#", true],
  ] as const)("缺模块路径的失败范围与健康桥并存：分隔 %s，失败项在后 %s", async (separator, failedLast) => {
    const file = writeBridgeModule();
    const malformed = `${separator}createToolExecutor${separator}metrics.read`;
    const healthy = `${file}::createDemoExecutor::demo.*`;
    process.env.WORKLOOM_TOOL_EXECUTOR_MODULES = (failedLast ? [healthy, malformed] : [malformed, healthy]).join(",");
    const executor = await loadDeploymentToolExecutor(scope);
    expect(executor?.supportsTool?.("metrics.read")).toBe(true);
    expect(await executor!("metrics.read", {})).toMatchObject({
      result: { state: "connector-required", reason: "connector-load-failed" },
      receipt: { synced: false, mode: "real" },
    });
    expect((await executor!("demo.run", {})).receipt).toMatchObject({ synced: true, mode: "real" });
    expect(executor?.supportsTool?.("other.tool")).toBe(false);
    expect(await describeToolCoverage(scope, ["metrics.read", "demo.run"])).toEqual({
      covered: ["demo.run"], uncovered: ["metrics.read"], bridges: 1,
    });
  });

  it.each([false, true])("混合配置的失败项无工具范围时保守停线，健康显式范围仍可用：失败项在后 %s", async (failedLast) => {
    const file = writeBridgeModule();
    const healthy = `${file}::createDemoExecutor::demo.*`;
    process.env.WORKLOOM_TOOL_EXECUTOR_MODULES = (failedLast ? [healthy, "::createToolExecutor"] : ["::createToolExecutor", healthy]).join(",");
    const executor = await loadDeploymentToolExecutor(scope);
    expect(executor?.supportsTool?.("metrics.read")).toBe(true);
    expect(executor?.supportsTool?.("other.tool")).toBe(true);
    expect(await executor!("metrics.read", {})).toMatchObject({
      result: { state: "connector-required", reason: "connector-load-failed" },
      receipt: { synced: false, mode: "real" },
    });
    expect((await executor!("demo.run", {})).receipt).toMatchObject({ synced: true, mode: "real" });
  });

  it("旧单桥变量中的畸形声明与新规格表健康桥共存时仍保留失败范围", async () => {
    const file = writeBridgeModule();
    process.env.WORKLOOM_TOOL_EXECUTOR_MODULE = "::createToolExecutor::metrics.read";
    process.env.WORKLOOM_TOOL_EXECUTOR_MODULES = `${file}::createDemoExecutor::demo.*`;
    const executor = await loadDeploymentToolExecutor(scope);
    expect(executor?.supportsTool?.("metrics.read")).toBe(true);
    expect((await executor!("metrics.read", {})).receipt).toMatchObject({ synced: false, mode: "real" });
    expect((await executor!("demo.run", {})).receipt).toMatchObject({ synced: true, mode: "real" });
  });

  it("失败桥停在自己范围，其它已装配桥仍可执行真实工具", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "wl-bridge-missing-")), "missing.mjs");
    const file = writeBridgeModule();
    process.env.WORKLOOM_TOOL_EXECUTOR_MODULES = `${missing}::createDemoExecutor::broken.*,${file}::createDemoExecutor::demo.*`;
    const executor = await loadDeploymentToolExecutor(scope);
    expect((await executor!("broken.run", {})).receipt.synced).toBe(false);
    expect((await executor!("demo.run", {})).receipt).toMatchObject({ synced: true, mode: "real" });
    expect(executor?.supportsTool?.("other.tool")).toBe(false);
  });

  it("老模块 supportsTool 声明参与逐工具路由，无声明工具返回未覆盖", async () => {
    const file = writeBridgeModule();
    writeFileSync(file, `
export function supportsTool(name) { return name === "single.read"; }
export function createToolExecutor() { return async () => ({ result: {}, receipt: { synced: true } }); }
`);
    process.env.WORKLOOM_TOOL_EXECUTOR_MODULES = file;
    const executor = await loadDeploymentToolExecutor(scope);
    expect(executor?.supportsTool?.("single.read")).toBe(true);
    expect(executor?.supportsTool?.("other.tool")).toBe(false);
    expect((await executor!("other.tool", {})).receipt.synced).toBe(false);
  });
});
