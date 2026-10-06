/**
 * runtime · 通用工具执行边界。
 *
 * 基座只理解「工具是否由当前已装配 preset 声明」以及「回执是否可核验」，
 * 不理解任何行业对象或业务动作。真实执行器由部署适配器注入；示例 Bundle
 * 只有在档案明确标记 dataMode=simulated 时，才允许走通用模拟器。
 */
import { createHash } from "node:crypto";

export interface ToolReceipt {
  synced: boolean;
  snapshot_uri?: string;
  verified_at?: string;
  /**
   * GR-15：回执来源模式——simulated=演示档案的本地模拟回执；real=真实连接器回执。
   * 任务卡与事件账本据此区分「假回执」与「真回执」，二者不得外观相同。
   */
  mode?: "simulated" | "real";
  error?: string;
}

export interface ToolExecutionContext {
  tenantId: string;
  workspaceId: string;
  threadId: string;
  stepId: string;
  fingerprint: string;
}

/** 存在 decision 扩展槽，保持冻结的五元 receipt Schema 不变。 */
export interface ToolExecutionEvidence {
  schema: "workloom.tool-execution/v1";
  issuer: "runtime-simulator";
  mode: "simulated";
  tenant_id: string;
  workspace_id: string;
  thread_id: string;
  step_id: string;
  tool: string;
  step_fingerprint: string;
  input_sha256: string;
  result_sha256: string;
  snapshot_uri: string;
  issued_at: string;
}

export interface ToolResult {
  result: Record<string, unknown>;
  receipt: ToolReceipt;
  execution?: ToolExecutionEvidence;
}

export type ToolExecutor = ((
  name: string,
  params: Record<string, unknown>,
) => Promise<ToolResult>) & {
  /** 部署注册表的可信覆盖声明；只有明确 false 才允许模拟档案使用本地兜底。 */
  supportsTool?: (name: string) => boolean;
};

export interface DeclaredToolExecution {
  allowedTools: readonly string[];
  simulated: boolean;
  context?: ToolExecutionContext;
}

/** 键排序的 JSON 结构摘要；不把原始参数再复制进回执结果。 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort()
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function structureHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function validContext(context: ToolExecutionContext | undefined): context is ToolExecutionContext {
  return Boolean(context && [context.tenantId, context.workspaceId, context.threadId, context.stepId]
    .every((value) => typeof value === "string" && value.trim().length > 0)
    && /^[a-f0-9]{64}$/.test(context.fingerprint));
}

function snapshotUri(context: ToolExecutionContext, name: string, resultHash: string): string {
  return `workloom-sim://receipt/${[context.tenantId, context.workspaceId, context.threadId, context.stepId, name, resultHash]
    .map(encodeURIComponent).join("/")}`;
}

/**
 * 校验本地模拟执行证据；没有证据的 simulated 成功不能用于当次进度或 replay。
 * 真实桥仍按既有回执契约处理；该函数不会把缺连接器或失败结果升格成成功。
 */
export function toolResultVerified(
  out: ToolResult,
  context: ToolExecutionContext,
  name: string,
  params: Record<string, unknown>,
): boolean {
  if (out.receipt?.synced !== true) return false;
  if (out.result?.state === "connector-required" || out.result?.state === "simulation-context-required") return false;
  if (!out.execution) return out.receipt.mode !== "simulated" && out.result?.state !== "simulated";
  const evidence = out.execution;
  if (!validContext(context) || evidence.schema !== "workloom.tool-execution/v1"
    || evidence.issuer !== "runtime-simulator" || evidence.mode !== "simulated"
    || out.receipt.mode !== "simulated" || out.result?.state !== "simulated") return false;
  if (evidence.tenant_id !== context.tenantId || evidence.workspace_id !== context.workspaceId
    || evidence.thread_id !== context.threadId || evidence.step_id !== context.stepId
    || evidence.tool !== name || evidence.step_fingerprint !== context.fingerprint) return false;
  if (evidence.input_sha256 !== structureHash(params) || out.result.input_sha256 !== evidence.input_sha256
    || evidence.result_sha256 !== structureHash(out.result)) return false;
  if (evidence.snapshot_uri !== snapshotUri(context, name, evidence.result_sha256)
    || out.receipt.snapshot_uri !== evidence.snapshot_uri
    || !Number.isFinite(Date.parse(evidence.issued_at)) || out.receipt.verified_at !== evidence.issued_at) return false;
  return true;
}

/**
 * 无行业假设的安全兜底执行器：
 * - 未由 preset 声明的工具直接拒绝；
 * - 真实数据态没有适配器时返回“未核实”，任务不得宣称完成；
 * - 仅模拟数据态生成可验证的本地模拟回执。
 */
export async function executeDeclaredTool(
  name: string,
  params: Record<string, unknown>,
  options: DeclaredToolExecution,
): Promise<ToolResult> {
  if (!options.allowedTools.includes(name)) {
    throw new Error("工具未在当前数字员工的能力清单中声明");
  }
  if (!options.simulated) {
    return {
      result: { state: "connector-required" },
      receipt: { synced: false, mode: "real" },
    };
  }
  if (!validContext(options.context)) {
    return {
      result: { state: "simulation-context-required" },
      receipt: { synced: false, mode: "simulated", error: "simulation-context-required" },
    };
  }
  const context = options.context;
  const verifiedAt = new Date().toISOString();
  const inputHash = structureHash(params);
  // 这是已执行的本地模拟结构记录；没有平台账号数据，不声称外部动作生效。
  const result = { state: "simulated", input_sha256: inputHash };
  const resultHash = structureHash(result);
  const snapshot = snapshotUri(context, name, resultHash);
  return {
    result,
    receipt: {
      synced: true,
      mode: "simulated",
      snapshot_uri: snapshot,
      verified_at: verifiedAt,
    },
    execution: {
      schema: "workloom.tool-execution/v1", issuer: "runtime-simulator", mode: "simulated",
      tenant_id: context.tenantId, workspace_id: context.workspaceId,
      thread_id: context.threadId, step_id: context.stepId, tool: name,
      step_fingerprint: context.fingerprint, input_sha256: inputHash, result_sha256: resultHash,
      snapshot_uri: snapshot, issued_at: verifiedAt,
    },
  };
}
