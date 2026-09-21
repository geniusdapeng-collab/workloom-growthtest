# growthtest × Codex 工作台改造计划

> 范围：`workloom-growthtest` 隔离实验副本（`syncPolicy: none-in-none-out`）。
> 纪律：本仓改动**不回流基座**、不参与 base-sync；公共化必须另开提案任务卡按 L2→L1→L0 重做。
> 关联验收：[`tools/codex-gateway/ACCEPTANCE.md`](../tools/codex-gateway/ACCEPTANCE.md)

## 0. 一句话目标

把 Codex 变成 growthtest 的人类总工作台；growthtest 只保留一个数字人团队工作台界面；所有 WorkLoom 能力通过一个"只读起步、逐步收敛到围栏→人审→五元事件→回执"的能力网关暴露给 Codex、CLI 与工作台。

## 1. 目标与非目标

**目标**

1. 在 Codex 里用一句话发现并理解 WorkLoom 的能力（员工/技能/管线/围栏）。
2. 数字人团队工作台实时显示工位、Run、审批、KPI、额度；页面只是观察者与点按入口。
3. 所有写操作经能力网关：围栏裁决 → 高风险人审 → 五元事件 → 回执；无回执不算完成。
4. 长任务（视频/内容/投放）后台可查、可订阅、可通知，不再出现"看不见但在烧额度"。

**非目标**

- 不回流基座、不改 `packages/base/**` 与 `bundles/**` 语义、不碰 `sync/**`、`.cnb.yml`、迁移。
- P0 不给 Codex 任何写权限。
- 不做多租户/多行业/生产部署；不做真实资金与真实对外发布。

## 2. 现状事实

- 隔离副本：`none-in-none-out`，HEAD `main@98d5ecd`，已做"基座去审批化"实验（下线审批中心 UI，保留业务链路关卡）。
- 能力：3 个 bundle（geo-growth / ai-video / hotel）；目录实测 73 员工 / 71 技能 / 10 管线 / 77 围栏 / 15 闸门。
- UI 资产：`Stage3D`、`components/hud/*`（TriGestureBar、EmergencyBrake、DispatchBar、FenceLight、NightStatusPill、KpiGauge 等）、`star-ring`、`loommate`、`shell/Bridge`（左栏会话槽）。
- 依赖：`pnpm install --frozen-lockfile` 已可完成（574 包）；Node 通过 Codex 捆绑运行时或系统 Node ≥24。

## 3. 阶段

### P0（已完成）：只读骨架

交付：`tools/codex-gateway/`（catalog/snapshot/SSE/MCP/CLI/stage）、`plugins/workloom-workbench/`（skills + MCP + hooks）、仓内 marketplace、单测与验收记录。

验收：doctor 全 PASS；11 项单测全绿；插件校验通过；真实模型通过 MCP 调用目录并正确解释闸门；工作台页可打开、SSE 可订阅、模拟数据有徽章。

### P1：治理闭环

**状态（2026-09-22）：已完成并通过真机验收**——详见 [`tools/codex-gateway/ACCEPTANCE.md`](../tools/codex-gateway/ACCEPTANCE.md) §P1。

- Run 协议：`run_start/status/tail/cancel`，状态含 `waiting_approval`，`completed` 必须有 receipt。
- 审批：`approval_list/decide`（三手势），接 review-console / 实验 approval adapter；过期与篡改 fail-closed。
- 围栏：所有写工具先调 `fence-engine` 纯函数判定（block > review > auto）。
- 审计：Codex hooks（PreToolUse / PostToolUse / Stop / SessionStart）→ 网关 append → 五元事件（先本地哈希链 JSONL，后接 workdata）。
- 验收：一个 G9 或 G12 场景端到端；block 直接终止；无回执标"未核实"。

真机实测补充（2026-09-22）：

1. Codex 会把 `readOnlyHint:false` 的 MCP 工具视为需要审批；`codex exec` 默认策略 `never` 会在 Codex 层
   直接拒绝（未进入网关）。交互式场景保持这一层；无人值守场景可对 `workloom-core` 设
   `default_tools_approval_mode="auto"`，但**网关内部的 G9/G12 人审仍强制**，不因 Codex 层放行而降级。
2. 围栏上下文缺失（如未提供 `account_daily_published`）会触发规则求值异常并按 fail-closed block；
   `run_start` 返回的 `fence.evalErrors` 必须展示给调用方，由其补齐上下文后重试，禁止伪造上下文。
3. 策略桥复用 `apps/server/src/trpc/router.ts` 对 G*/G-GEO* 的裸 YAML 装载口径；
   `loadFencePack` 的 R 号 zod 校验不适用于 growth 线，不能强改基座。

### P2：数字人工作台

- `apps/web` Stage3D / hud / Bridge 接 `/stage/snapshot` + SSE；左栏注入 Codex 线程/Run；三手势、派遣、制动接网关写 API。
- 先 shadow 只读一周，再开放写按钮；每个写按钮二次确认 + 审计。
- 验收：桌面/窄屏无溢出；loading/empty/error/offline 全态；真实/模拟徽章正确。

### P3：真实数据与长任务

- 数据走 `apps/server` tRPC/HTTP 只读接口；不直连 DB。
- 视频/内容管线 Run 化：进度、成本/额度、审批、回执、产物 URI；通知走 Codex/Pets/IM。
- 验收：客户端关闭后任务继续；重开回放补齐；成本可查。

### P4：硬化与决策门

**状态（2026-09-22）：账本镜像已完成并通过真机验收**（含真实模型终验）；真实连接器、审批落业务库、MCP allow/deny 与生产部署仍待后续。

- 安全（MCP allow/deny、审批模式、hooks 信任、回环、秘密扫描）、门禁、报告。
- 决策：是否提案公共化；是否并行 DSH Desktop 插件 PoC；是否退役旧工作台页面。

## 4. 接口契约（P0）

- CLI：`catalog list|describe`、`stage snapshot|serve`、`doctor`、`context`、`mcp`。
- MCP：`workloom_catalog_search`、`workloom_catalog_describe`、`workloom_stage_snapshot`、`workloom_stage_url`、`workloom_health`；资源 `workloom://catalog`、`workloom://stage/snapshot`、`workloom://health`。
- HTTP/SSE：`/health`、`/catalog`、`/catalog/:id`、`/stage/snapshot`、`/stage/stream`、`/stage`。
- 数据模式：目录 `dataMode=generated`；运行态 `dataMode=mock`（P1 接真实后区分 simulated/real）。

## 5. 安全与治理

- 默认只绑定 `127.0.0.1`；CORS 仅放行 localhost；不连 DB、不写业务数据、不读密钥。
- 写路径 P1 才开放；强制点在网关内部，Codex hooks/审批弹窗只是入口与补充。
- growthtest 的"去审批化"实验：不恢复旧审批中心 UI，人审入口迁到 Codex + 工作台，但后端围栏与审批对象保留、fail-closed。

## 6. 回滚

改动集中在 `tools/`、`plugins/`、`.agents/`、`docs/` 与后续 `apps/web` 接线；不触碰基座资产。回滚 = revert 本任务分支提交，或删除分支。
