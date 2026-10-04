/** QUEST 发布验收必须有实际执行进度，失败或无回执不得由“已建线程”替代。 */
export interface QuestGateDispatch {
  kind?: string;
  mode?: string;
  threadId?: string;
  status?: string;
  stepsTotal?: number;
  stepsDone?: number;
  pendingApprovalId?: string;
  unverified?: unknown[];
  error?: string;
}

export function assertQuestExecution(
  dispatch: QuestGateDispatch,
  thread: { id?: string; status?: string } | null | undefined,
): string {
  const fail = (message: string): never => { throw new Error(`QUEST 未通过：${message}`); };
  if (dispatch.kind !== "routed" || dispatch.mode !== "quest") fail(`未按 quest 路由（${dispatch.kind}/${dispatch.mode}）`);
  if (!dispatch.threadId || !thread || thread.id !== dispatch.threadId) fail("线程回读失败");
  if (!Number.isInteger(dispatch.stepsTotal) || (dispatch.stepsTotal ?? 0) < 2) fail(`未拆解多步骤（stepsTotal=${dispatch.stepsTotal}）`);
  if (!Number.isInteger(dispatch.stepsDone) || (dispatch.stepsDone ?? 0) < 1 || dispatch.stepsDone! > dispatch.stepsTotal!) {
    fail(`没有有效执行进度（${dispatch.stepsDone}/${dispatch.stepsTotal}，状态 ${dispatch.status}）`);
  }
  if (!["running", "pending_review", "completed"].includes(dispatch.status ?? "")) fail(`任务状态 ${dispatch.status}：${dispatch.error ?? "未完成有效执行"}`);
  if (thread!.status !== dispatch.status) fail(`线程状态不一致（派遣 ${dispatch.status}，回读 ${thread!.status}）`);
  if (dispatch.unverified?.length) fail(`存在 ${dispatch.unverified.length} 个未核实步骤`);
  if (dispatch.status === "completed" && dispatch.stepsDone !== dispatch.stepsTotal) fail("已完成状态与执行步数不一致");
  if (dispatch.status === "pending_review" && !dispatch.pendingApprovalId?.trim()) fail("待审批状态没有审批回执");
  return `拆解 ${dispatch.stepsTotal} 步 · 已执行 ${dispatch.stepsDone} 步 · 状态 ${dispatch.status}`;
}
