import type { PipelineScope } from "./contracts.js";

export const PROJECT_EXECUTION_LEASE_NAMESPACE = "project-run" as const;
export const PIPELINE_CONTROL_STATE_LOCK_NAMESPACE = "pipeline-control-state" as const;

/**
 * 全链路项目执行租约键。Studio、Director、FilmWorker、CLI 补跑和渲染修复必须使用同一编码。
 * JSON 数组编码避免 `tenant/workspace/project` 分隔符歧义。
 */
export function projectExecutionLeaseKey(scope: PipelineScope, projectId: string): string {
  if (![scope.tenantId, scope.workspaceId, projectId].every((value) =>
    typeof value === "string" && value.trim().length > 0)) {
    throw new Error("PROJECT_EXECUTION_LEASE_SCOPE_INVALID");
  }
  return JSON.stringify([PROJECT_EXECUTION_LEASE_NAMESPACE, scope.tenantId, scope.workspaceId, projectId]);
}

/**
 * 控制面短事务 CAS 锁。它与长时间持有的 project-run 执行租约分属不同命名空间：
 * 同一键会让影子写入等待整条媒体运行结束，既失去可观测性，也可能耗尽连接池。
 */
export function pipelineControlStateLockKey(scope: PipelineScope, projectId: string): string {
  if (![scope.tenantId, scope.workspaceId, projectId].every((value) =>
    typeof value === "string" && value.trim().length > 0)) {
    throw new Error("PIPELINE_CONTROL_STATE_LOCK_SCOPE_INVALID");
  }
  return JSON.stringify([PIPELINE_CONTROL_STATE_LOCK_NAMESPACE, scope.tenantId, scope.workspaceId, projectId]);
}

export interface ProjectExecutionLease {
  projectId: string;
  leaseKey: string;
  release(): Promise<void>;
}
