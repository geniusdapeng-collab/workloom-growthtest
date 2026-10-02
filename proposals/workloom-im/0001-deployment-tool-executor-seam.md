# 基座提案：部署层 ToolExecutor 注入 seam（workloom-im）

> **状态：暂缓（2026-09-19）**。产品所有者决定：该能力先在 WorkLoom-growth 实验车道验证，
> 暂不修改/推送基座；待能力稳定后再重新开卡实施。本文件与同目录补丁
> `0001-deployment-tool-executor-seam.patch` 是待实施版本，**不包含在本 PR 的生效改动内**。
>
> 已完成的本地实现与验证（workloom-im 本地分支 `task/T-2026-0919-0011`，commit `2d007c3`，未推送）：
> - `apps/server/src/runtime/tool-executor.ts`：`loadDeploymentToolExecutor(scope)`，fail-closed；
> - `apps/server/src/trpc/router.ts`：两处 `runQuest` 注入（有执行器才传，否则保持原语义）；
> - `packages/runtime/src/tools.ts`：`runToolSafely`（执行器异常 → 未核实回执）；
> - `packages/runtime/src/loop.ts`：改用 `runToolSafely`；
> - 单测 9/9 通过（loader 6 例 + runToolSafely 3 例）。
>
> growth 侧的过渡生产入口：`scripts/visual-quest-runner.mts`（行业脚本，直接向 `runQuest`
> 注入视觉工位执行器，不改任何基座文件）。

> 提案人：WorkLoom-growth 视觉工位任务（T-20260919-9001）
> 目标：让基座服务端能把「真实连接器执行器」交给 `runQuest`，而不需要在基座里写任何行业词。
> 背景证据：`packages/runtime/src/trpc/router.ts` 两处 `runQuest(...)` 未传 `toolExecutor`；
> 未注入时走 `executeDeclaredTool` 兜底（真实数据态返回 `connector-required`，任务标未核实）。

## 现状

```ts
// apps/server/src/trpc/router.ts（当前）
const r = await runQuest(app, getGatewayPool(), scope, {
  threadId, goal: input.title, presetKey: input.presetKey, llmCall: llmCall("quest-plan", scope),
  fallbackPlanner: acquisitionQuestPlanner(input.title),
});
```

- `runQuest` 的 `input.toolExecutor?: ToolExecutor` 是现成 seam（`packages/runtime/src/loop.ts`）；
- 但没有宿主注入点：行业仓只能改 router（基座文件，会被 base-sync 覆盖），或被迫把行业连接器写进基座。

## 提案（最小、行业零词汇）

### 1. 新增 `apps/server/src/runtime/tool-executor.ts`

```ts
import type { ToolExecutor } from "@workloom/runtime";

/**
 * 部署层工具执行器：仅按环境变量动态加载，基座不认识任何行业/连接器。
 * 未配置 → undefined → runQuest 保持默认兜底（未核实语义）。
 */
export async function loadDeploymentToolExecutor(): Promise<ToolExecutor | undefined> {
  const modulePath = process.env.WORKLOOM_TOOL_EXECUTOR_MODULE;
  if (!modulePath) return undefined;
  const mod = await import(modulePath);
  const factory = mod?.createToolExecutor;
  if (typeof factory !== "function") {
    throw new Error(`WORKLOOM_TOOL_EXECUTOR_MODULE 未导出 createToolExecutor(): ${modulePath}`);
  }
  const executor = await factory();
  return typeof executor === "function" ? executor as ToolExecutor : undefined;
}
```

### 2. router 两处 `runQuest` 注入

```diff
+ import { loadDeploymentToolExecutor } from "../runtime/tool-executor.js";
@@ thread.create / thread.advance
+ const toolExecutor = await loadDeploymentToolExecutor();
  const r = await runQuest(app, getGatewayPool(), scope, {
    threadId, goal: input.title, presetKey: input.presetKey, llmCall: llmCall("quest-plan", scope),
    fallbackPlanner: acquisitionQuestPlanner(input.title),
+   ...(toolExecutor ? { toolExecutor } : {}),
  });
```

### 3. 部署配置（行业侧，不进基座）

```bash
WORKLOOM_TOOL_EXECUTOR_MODULE=/srv/workloom/bundles/geo-growth/connectors/visual-bridge/server-adapter.mts
WORKLOOM_VISUAL_BRIDGE_URL=http://10.x.x.x:9773
WORKLOOM_VISUAL_BRIDGE_TOKEN_FILE=/etc/workloom/secrets/visual-bridge.token
```

## 验收与回滚

- 验收：`RUN_DB_TESTS=1` 下执行本仓 `runtime-smoke.mts` 同口径用例——干净任务 3 步 completed 且 `biz_events.receipt.synced=true`；未配置 env 时行为与现状完全一致（未核实）。
- 安全：模块路径来自部署环境；加载失败 fail-closed（抛错拒绝建单），不静默降级成模拟回执。
- 回滚：删除 env 即回到兜底执行器；无需改数据。

## 风险

- 动态 import 的权限面：仅允许部署方写入的受控路径（不建议指向可被租户写入的目录）；
- 需在灰度环境验证冷启动时的模块加载耗时（一次 import，可缓存）。
