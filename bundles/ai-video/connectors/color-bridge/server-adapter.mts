/**
 * 部署适配器（ai-video × 调色工位）：把 createToolExecutor() 交给宿主注入 runQuest。
 *
 *   WORKLOOM_COLOR_BRIDGE_URL    调色工位端点（支持逗号分隔多端点）
 *   WORKLOOM_COLOR_BRIDGE_TOKEN  工位 token（受控秘密存储/本机文件；不进仓库、不进日志）
 *   WORKLOOM_COLOR_BRIDGE_TENANT 本部署绑定的租户工作区 id
 *
 * 未配置 → 返回 undefined → 保持基座默认兜底（真实数据态「未核实」），不伪造回执。
 * 用法（部署层，不改基座文件）：
 *   WORKLOOM_TOOL_EXECUTOR_MODULE=.../server-adapter.mts node apps/server/...
 * 或行业脚本直接注入：见 runtime-smoke.mts / scripts/color-quest-runner.mts。
 */

import type { ToolExecutor } from "./executor.ts";
import { createColorBridgeExecutor } from "./executor.ts";

export async function createToolExecutor(): Promise<ToolExecutor | undefined> {
  const rawUrl = (process.env.WORKLOOM_COLOR_BRIDGE_URL ?? "").trim();
  const token = (process.env.WORKLOOM_COLOR_BRIDGE_TOKEN ?? "").trim();
  if (!rawUrl || !token) return undefined;
  const baseUrl = rawUrl.split(",").map((entry) => entry.trim()).filter(Boolean);
  return createColorBridgeExecutor({
    baseUrl,
    token,
    tenantId: (process.env.WORKLOOM_COLOR_BRIDGE_TENANT ?? "").trim() || undefined,
    timeoutMs: Number(process.env.WORKLOOM_COLOR_BRIDGE_TIMEOUT_MS ?? 900_000),
    idempotencyPrefix: (process.env.WORKLOOM_COLOR_IDEMPOTENCY_PREFIX ?? "prod-color").trim(),
  });
}

export default createToolExecutor;
