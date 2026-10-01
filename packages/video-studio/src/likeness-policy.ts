/**
 * likeness-policy —— “机器像不像”结果的处置口径（T-2026-1001-0007）。
 *
 * 口径（产品所有者 2026-10-01）：机器像不像判据本身不稳定（同一批文件实测 92 / 15 / 86），
 * **默认只留证、不阻断、不触发自动重做**；只有显式 `--require-likeness` 时才整批拒绝（旧行为 opt-in）。
 * 自动重做由机器评分触发正是“反复提交生成烧钱”的根源之一，本模块把它固化成一条可单测的策略。
 */
export interface LikenessEntry {
  angle: string;
  ok: boolean;
  score?: number | null;
  reason?: string | null;
}

export interface LikenessBatchDecision {
  /** 未过机器阈值的角度（原样返回，供留证） */
  failed: LikenessEntry[];
  /** 只有显式 --require-likeness 且存在失败角度时才阻断 */
  blocking: boolean;
  /** 给日志/报告的一句话结论 */
  summary: string;
}

export function assessLikenessBatch(
  entries: readonly LikenessEntry[],
  options: { requireLikeness?: boolean } = {},
): LikenessBatchDecision {
  const failed = entries.filter((entry) => !entry.ok);
  const require = options.requireLikeness === true;
  if (failed.length === 0) {
    return { failed, blocking: false, summary: `${entries.length} 个角度均通过机器像不像留证` };
  }
  return {
    failed,
    blocking: require,
    summary: require
      ? `${failed.length}/${entries.length} 个角度低于机器阈值（--require-likeness：整批拒绝）`
      : `${failed.length}/${entries.length} 个角度低于机器阈值（只留证、不阻断；决策交人类）`,
  };
}
