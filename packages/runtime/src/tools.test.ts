/** MC-006：模拟动作只能签发绑定当前作用域与结果结构的本地回执，不能冒充真实平台动作。 */
import { describe, expect, it } from "vitest";
import { executeDeclaredTool, toolResultVerified } from "./tools.js";

const context = {
  tenantId: "tenant-a", workspaceId: "ws-a", threadId: "thread-a", stepId: "s1",
  fingerprint: "a".repeat(64),
};
const options = { allowedTools: ["metrics.read"], simulated: true, context };

describe("MC-006 本地模拟回执绑定", () => {
  it("真实数据态没有连接器仍未核实，不因上下文齐备伪称成功", async () => {
    const out = await executeDeclaredTool("metrics.read", {}, { ...options, simulated: false });
    expect(out).toMatchObject({ result: { state: "connector-required" }, receipt: { synced: false, mode: "real" } });
  });

  it("模拟档案缺当前线程/步骤上下文不能签发 synced=true", async () => {
    const out = await executeDeclaredTool("metrics.read", {}, { allowedTools: options.allowedTools, simulated: true });
    expect(out.receipt).toMatchObject({ synced: false, mode: "simulated" });
  });

  it("执行结构记录绑定租户、工作区、线程、步骤、工具、参数与返回结果", async () => {
    const out = await executeDeclaredTool("metrics.read", { window: "本周" }, options);
    expect(out.receipt).toMatchObject({ synced: true, mode: "simulated" });
    expect(out.execution).toMatchObject({
      schema: "workloom.tool-execution/v1", issuer: "runtime-simulator", mode: "simulated",
      tenant_id: context.tenantId, workspace_id: context.workspaceId,
      thread_id: context.threadId, step_id: context.stepId, tool: "metrics.read",
      step_fingerprint: context.fingerprint,
      input_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      result_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      snapshot_uri: out.receipt.snapshot_uri, issued_at: out.receipt.verified_at,
    });
    expect(out.receipt.snapshot_uri).toContain("workloom-sim://");
    // 事件里的回执可保存摘要，不再把原始工具参数复制到模拟结果。
    expect(JSON.stringify(out.result)).not.toContain("本周");
  });

  it("参数键顺序不影响摘要，值或结果改变必须改变摘要", async () => {
    const a = await executeDeclaredTool("metrics.read", { a: 1, b: ["✓", "x"] }, options);
    const b = await executeDeclaredTool("metrics.read", { b: ["✓", "x"], a: 1 }, options);
    const c = await executeDeclaredTool("metrics.read", { a: 2, b: ["✓", "x"] }, options);
    expect(a.execution?.input_sha256).toBe(b.execution?.input_sha256);
    expect(a.execution?.input_sha256).not.toBe(c.execution?.input_sha256);
    expect(a.execution?.result_sha256).not.toBe(c.execution?.result_sha256);
  });

  it.each(["tenantId", "workspaceId", "threadId", "stepId", "fingerprint"])("空 %s 拒绝签发", async (field) => {
    const out = await executeDeclaredTool("metrics.read", {}, { ...options, context: { ...context, [field]: "" } });
    expect(out.receipt.synced).toBe(false);
  });

  it("未声明工具不能使用模拟器，保持权限拒绝", async () => {
    await expect(executeDeclaredTool("shell.exec", {}, options)).rejects.toThrow("工具未在当前数字员工");
  });

  it("真实标签也不能让 connector-required 或脱掉绑定的本地模拟结果变为已核实", async () => {
    const out = await executeDeclaredTool("metrics.read", {}, options);
    expect(toolResultVerified({ result: out.result, receipt: { synced: true, mode: "real" } }, context, "metrics.read", {})).toBe(false);
    expect(toolResultVerified({ result: { state: "connector-required" }, receipt: { synced: true, mode: "real" } }, context, "metrics.read", {})).toBe(false);
  });

  it("空参数和特殊字符可以执行；不同作用域、参数、结果、快照或时间不得复用", async () => {
    const params = { text: "汉字 / ✓ \" \\n", nested: { empty: null, values: [false, 0, ""] } };
    const out = await executeDeclaredTool("metrics.read", params, options);
    expect(toolResultVerified(out, context, "metrics.read", params)).toBe(true);
    for (const field of ["tenantId", "workspaceId", "threadId", "stepId", "fingerprint"] as const) {
      expect(toolResultVerified(out, { ...context, [field]: field === "fingerprint" ? "b".repeat(64) : "other" }, "metrics.read", params)).toBe(false);
    }
    expect(toolResultVerified(out, context, "different.read", params)).toBe(false);
    expect(toolResultVerified(out, context, "metrics.read", { ...params, text: "altered" })).toBe(false);
    expect(toolResultVerified({ ...out, result: { ...out.result, added: true } }, context, "metrics.read", params)).toBe(false);
    expect(toolResultVerified({ ...out, receipt: { ...out.receipt, snapshot_uri: "workloom-sim://other" } }, context, "metrics.read", params)).toBe(false);
    expect(toolResultVerified({ ...out, receipt: { ...out.receipt, verified_at: "invalid" } }, context, "metrics.read", params)).toBe(false);
  });
});
