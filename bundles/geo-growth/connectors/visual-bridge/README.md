# 视觉工位 bridge 连接器（geo-growth）

把 `visualread.* / visualwrite.*` 工具接到 Mac 视觉工位（Compositor 渲染内核）。

## 部署形态

```
WorkLoom（大脑，云端/机房）                Mac 视觉工位（手，独立内网）
  runtime ToolExecutor  ──HTTP/Bearer──▶  visual-bridge (127.0.0.1:9773 或内网反代)
                                            └─ compositor-cli（Compositor 渲染内核）
                                                └─ 素材区 / 成品区 / 回执
```

## 接线

```ts
import { createVisualBridgeExecutor } from "./bundles/geo-growth/connectors/visual-bridge/executor.ts";

const toolExecutor = createVisualBridgeExecutor({
  baseUrl: process.env.WORKLOOM_VISUAL_BRIDGE_URL!,
  token: process.env.WORKLOOM_VISUAL_BRIDGE_TOKEN!,
  timeoutMs: 300_000,
});
// 注入宿主：packages/runtime/src/loop.ts 的 input.toolExecutor（部署适配器负责）
```

## 安全

- token 只从受控秘密存储或工位本机文件读取，不进仓库、不进日志；
- 工位在独立 VLAN，出站白名单；bridge 默认只监听 127.0.0.1，跨机调用置于内网反代 + mTLS 之后；
- 客户素材与成品只落在工位/租户素材区，不上行蜂群；
- 无回执 = 未核实：executor 不会为缺失的 receipt 伪造 `synced`。

## 工具面

| 工具 | 类型 | 用途 |
|---|---|---|
| `visualread.health` | 读 | 工位与引擎健康探针 |
| `visualread.inspect` | 读 | 读 `.comp` 结构与图层清单 |
| `visualread.verify` | 读 | 尺寸/字节数/SHA-256 校验 |
| `visualwrite.compose` | 写 | 配方 → `.comp` → 多规格导出 |
| `visualwrite.render` | 写 | `.comp` → PNG/JPEG |
| `visualwrite.text` | 写 | 文案预渲染为透明 PNG（Compositor 无文字层） |

工位部署与版本 pin 见 `docs/visual-workstation.md`。

v0.2 追加：`visualread.stats`（配额/指标/队列）、`visualread.assets`（租户素材清单）；
`visualwrite.compose` 支持 `template + vars`；执行器自动注入 `tenant_id` 与幂等键、
多端点故障转移、软失败（`receipt.synced=false`，不抛异常）；bridge 侧配额/路径监狱/作业持久化。

## 运行时端到端（真实 PG + 真实围栏 + 真实 bridge）

```bash
set -a; source .env; set +a
./node_modules/.bin/tsx bundles/geo-growth/connectors/visual-bridge/runtime-smoke.mts
```

三个场景直接调用 `runQuest` 并注入本连接器（`toolExecutor`）：

| 场景 | 期望 | 本机实测（2026-09-19） |
|---|---|---|
| clean：干净配方 | 3 步完成，回执入库 | `completed` 3/3；`biz_events.receipt.synced=true`；G-VIS0 pass |
| blocked：文案含「国家级」 | G-VIS2 熔断 | `paused`，`blockedBy=视觉文案事实红线`；rule_impact: pass+blocked |
| review：配方未审 | G-VIS4 挂起审批 | `pending_review`，审批号 `apr-e-10451` |

产物 `runtime-cover.png` 的 sha256 与 `visualread.verify` 事件里的 `result.sha256` 完全一致。

## 宿主接线（部署层）

- 行业侧：`server-adapter.mts` 导出 `createToolExecutor()`（读 `WORKLOOM_VISUAL_BRIDGE_*` 环境变量）；
- 基座侧：提案 `proposals/workloom-im/0001-deployment-tool-executor-seam.md`
  （router 两处 `runQuest` 注入 `loadDeploymentToolExecutor()`，由 `WORKLOOM_TOOL_EXECUTOR_MODULE` 指向本适配器）；
- 未配置环境变量 → 返回 `undefined` → 保持基座默认兜底（未核实），不伪造回执。

## 截图能力（fail-closed）

`visualread.snapshot` 需要 bridge 进程获得一次性的**屏幕录制**权限（macOS TCC，无法脚本授予）。
未授权时返回 `screen_recording_permission_required` 并附授权路径；授权助手：

```bash
bash bridge/grant-screen-recording.sh   # 打开系统设置对应面板
```
