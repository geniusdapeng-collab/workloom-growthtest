/**
 * 部署侧适配器：把视觉工位 bridge 暴露成 WorkLoom 宿主要求的 ToolExecutor 工厂。
 *
 * 基座提案（proposals/workloom-im/0001-deployment-tool-executor-seam.md）落地后，
 * 服务端只需设置：
 *   WORKLOOM_TOOL_EXECUTOR_MODULE=<本文件路径>
 *   WORKLOOM_VISUAL_BRIDGE_URL=http://<工位内网IP>:9773
 *   WORKLOOM_VISUAL_BRIDGE_TOKEN=<受控秘密>
 * 宿主动态 import 本模块并调用 createToolExecutor()。
 *
 * 未配置 URL/TOKEN 时返回 undefined：宿主保持默认语义（模拟档案 → 本地回执；
 * 真实档案 → 未核实），绝不伪造成功。
 */

import { readFileSync } from "node:fs";
import { createVisualBridgeExecutor } from "./executor.ts";

export function createToolExecutor() {
  return createScopedToolExecutor();
}

/** 宿主若能把 scope 传进来，就按 workspace 作用域建执行器（推荐）。 */
export function createToolExecutorForScope(scope?: { tenantId?: string; workspaceId?: string }) {
  return createScopedToolExecutor(scope);
}

function createScopedToolExecutor(scope?: { tenantId?: string; workspaceId?: string }) {
  const endpoints = (process.env.WORKLOOM_VISUAL_BRIDGE_URLS
    ?? process.env.WORKLOOM_VISUAL_BRIDGE_URL
    ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const token = process.env.WORKLOOM_VISUAL_BRIDGE_TOKEN
    ?? readTokenFile(process.env.WORKLOOM_VISUAL_BRIDGE_TOKEN_FILE);
  if (endpoints.length === 0 || !token) return undefined;
  return createVisualBridgeExecutor({
    baseUrl: endpoints,
    token,
    tenantId: scope?.workspaceId ?? scope?.tenantId ?? process.env.WORKLOOM_VISUAL_BRIDGE_TENANT,
    timeoutMs: Number(process.env.WORKLOOM_VISUAL_BRIDGE_TIMEOUT_MS ?? 300_000),
    softFailures: process.env.WORKLOOM_VISUAL_BRIDGE_STRICT !== "1",
    idempotencyPrefix: process.env.WORKLOOM_VISUAL_BRIDGE_IDEMPOTENCY_PREFIX ?? "visual",
  });
}

function readTokenFile(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return readFileSync(path, "utf-8").trim() || undefined;
  } catch {
    return undefined;
  }
}
