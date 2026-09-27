/**
 * confirmation.ts —— 确认门桥：把 vendor 的 7 个人工确认门挂到宿主审批实现
 *
 * vendor/supermickey/scripts/confirmation-waiter.js 已打「hyperreality 融合桥」补丁：
 * 运行期读取 globalThis.__HR_CONFIRMATION_HANDLER__，存在即改走宿主处理器。
 * 全局入口只保留固定分发器；审批处理器属于各自的异步运行，不按启动/结束顺序装卸。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { GateRequest, GateVerdict } from "./gates.js";

export type ConfirmationHandler = (req: GateRequest) => Promise<GateVerdict>;

declare global {
  // eslint-disable-next-line no-var
  var __HR_CONFIRMATION_HANDLER__: ConfirmationHandler | undefined;
}

interface ConfirmationScope {
  handler: ConfirmationHandler;
  active: boolean;
}

const scopes = new AsyncLocalStorage<ConfirmationScope>();

function rejected(reason: string): GateVerdict {
  return { approved: false, reason, suggestions: [], fatal: reason };
}

const dispatchConfirmation: ConfirmationHandler = async (req) => {
  const scope = scopes.getStore();
  if (!scope) return rejected("confirmation-scope-missing");
  if (!scope.active) return rejected("confirmation-scope-closed");
  if (req.shouldAbort?.()) return rejected("confirmation-aborted");
  const verdict = await scope.handler(req);
  // 分离的子任务可能在主运行结束后才拿到裁决；结束/取消后不得补发批准。
  if (!scope.active) return rejected("confirmation-scope-closed");
  if (req.shouldAbort?.()) return rejected("confirmation-aborted");
  return verdict;
};

/**
 * 在一次预生产运行内路由确认请求。run 的 Promise 必须覆盖整个 vendor 调用链。
 *
 * 使用 run 而非 enterWith：调用方、并行任务和嵌套运行各自保有原作用域。
 * 固定分发器在运行结束后仍保留，无作用域/迟到调用明确拒绝，不能落回 vendor 文件审批。
 */
export async function runWithConfirmationHandler<T>(
  handler: ConfirmationHandler,
  run: () => T | Promise<T>
): Promise<T> {
  const installed = globalThis.__HR_CONFIRMATION_HANDLER__;
  if (installed && installed !== dispatchConfirmation) {
    throw new Error("confirmation-dispatcher-conflict");
  }
  globalThis.__HR_CONFIRMATION_HANDLER__ = dispatchConfirmation;
  const scope: ConfirmationScope = { handler, active: true };
  return scopes.run(scope, async () => {
    try {
      return await run();
    } finally {
      scope.active = false;
    }
  });
}

/** 开发/演示用：全部自动批准的处理器（生产环境禁止——确认门是生产纪律） */
export function autoApproveHandler(): ConfirmationHandler {
  return async (req) => ({
    approved: true,
    reason: `auto-approve(${req.type})`,
    suggestions: []
  });
}
