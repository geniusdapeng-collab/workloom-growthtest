/**
 * 部署适配器（ai-video × 字幕工位）：把 createSubtitleBridgeExecutor() 交给宿主注入 runQuest。
 *
 *   WORKLOOM_SUBTITLE_BRIDGE_URL     字幕工位端点（支持逗号分隔多端点）
 *   WORKLOOM_SUBTITLE_BRIDGE_TOKEN   工位 token（受控秘密存储/本机文件；不进仓库、不进日志）
 *   WORKLOOM_SUBTITLE_BRIDGE_TENANT  本部署绑定的租户工作区 id
 *
 * 未配置 → 返回 undefined → 保持基座默认兜底（真实数据态「未核实」），不伪造回执。
 * 用法（部署层，不改基座文件）：
 *   WORKLOOM_TOOL_EXECUTOR_MODULE=.../server-adapter.mts node apps/server/...
 */

import type { ToolExecutor } from "./executor.ts";
import { createSubtitleBridgeExecutor } from "./executor.ts";

export async function createToolExecutor(): Promise<ToolExecutor | undefined> {
  const rawUrl = (process.env.WORKLOOM_SUBTITLE_BRIDGE_URL ?? "").trim();
  const token = (process.env.WORKLOOM_SUBTITLE_BRIDGE_TOKEN ?? "").trim();
  if (!rawUrl || !token) return undefined;
  const baseUrl = rawUrl.split(",").map((entry) => entry.trim()).filter(Boolean);
  return createSubtitleBridgeExecutor({
    baseUrl,
    token,
    tenantId: (process.env.WORKLOOM_SUBTITLE_BRIDGE_TENANT ?? "").trim() || undefined,
    timeoutMs: Number(process.env.WORKLOOM_SUBTITLE_BRIDGE_TIMEOUT_MS ?? 900_000),
    idempotencyPrefix: (process.env.WORKLOOM_SUBTITLE_IDEMPOTENCY_PREFIX ?? "prod-subtitle").trim(),
  });
}

export default createToolExecutor;
