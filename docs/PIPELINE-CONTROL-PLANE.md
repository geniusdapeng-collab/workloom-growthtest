# GrowthTest 视频管线控制面（一期）

- 状态：已实现，影子模式
- 任务：`T-2026-1030-9001`
- 基线：`d70b1c28eee47b7c4269f22ab694ae05d64db12c`
- 范围：`CompiledPipelinePlan + Durable Control Plane + 双状态 + 统一项目租约 + StageAdapter 影子接入`
- 明确不做：总制片人 Agent、自动修复、真实媒体执行切换、vendor 算法重写、业务门禁语义调整

## 运行边界

旧执行器继续是真实出片路径。新控制面只观察已经发生的运行、阶段、产物和门裁决；影子写入失败只记
`[pipeline-shadow]` 日志，不得改变旧链路成败。

当前接入点：

| 旧执行器 | Adapter | 观察内容 |
|---|---|---|
| `studio-worker` | `vendor-preproduction` | legacy 预生产生命周期、G1–G7 真实门裁决与内容摘要 |
| `film-worker` | `render-post` | 固定工位作业、组件输入/输出、成功或失败 |
| `explainer` | `explainer` | 口播解说片逐阶段事件与输出摘要 |
| `delivery-revision` | `render-post` | 本地层增量返修作业与版本回执 |

所有观察器共用 `project-run/{tenantId}/{workspaceId}/{projectId}` 编码的 PostgreSQL advisory lease。
控制面写事务另用 `pipeline-control-state` 短锁，避免影子写入等待长执行租约。

## 编译式管线

`bundles/ai-video/pipelines/*.yml` 仍是声明面，但运行前必须编译为只读计划。编译器拒绝：

- 缺少或未知 StageAdapter；
- 未安装 owner preset；
- 未登记 gate；
- 重复节点、自依赖和依赖环。

生成清单：`bundles/ai-video/pipelines/compiled-plan-manifest.json`。

```bash
pnpm pipelines:compile
pnpm pipelines:check
```

## 持久状态

迁移 `0055_video_pipeline_control_plane.sql` 新增或扩展：

- `video_pipeline_runs`：冻结 plan、计划 hash、源运行、项目 revision、当前 frontier；
- `production_stage_runs`：`execution_status / verification_status / disposition`；
- `video_artifacts`：内容寻址产物引用；
- `video_stage_edges`：冻结依赖边；
- `video_gate_decisions`：绑定产物摘要、检查集版本和证据；
- `video_pipeline_events`：只增事件；
- `video_pipeline_command_receipts`：命令幂等回执。

GateDecision 同时保存 `artifactManifestHash` 与结构化 `GateFinding`（expected / actual /
fieldPath / repairClass / blocking），后续确定性修复不需要解析自然语言。

`production_stage_runs.item_key` 默认空字符串；镜头、角色等领域对象后续可进入 item 级恢复，
控制行唯一键按 `(pipeline_run_id,node_key,item_key,attempt)` 隔离。

旧唯一键 `(workspace_id, project_id, stage_id, attempt)` 暂保留。控制行仍按项目内 node+item
递增 attempt，因此兼容期内不会与历史 preproduction 行撞号；WP7 切换时再评估是否改成 legacy
partial unique index。

`stages.jsonl`、内存 run map 和旧 `production_stage_runs.status` 继续保留为兼容投影；新控制面不把
Agent 上下文或 JSONL 当作恢复事实源。

一期兼容期，旧的 Studio resume、archive watch、ProductionAuthority 与命令行恢复器都显式筛选
`pipeline_run_id IS NULL`，因此不会把影子控制行误当成旧出片阶段。切换到 WP7 时才统一读取视图。

## 状态语义

```text
executionStatus:
  pending | ready | running | output_ready | completed | failed | interrupted

verificationStatus:
  not_run | pending | passed | rejected | unverified | not_applicable

disposition:
  continue | repair | reconcile | wait_human | blocked | done | stop
```

“产物已生成但门拒绝”表现为 `executionStatus=output_ready`、`verificationStatus=rejected`，
不再折叠成单一 `failed`。

### 系统自动审批（T-2026-1031-9003）

GrowthTest 视频管线默认启用 `workloom.video-auto-approval/v1`：

- `requestGate` 在质量证据和 artifact manifest 已登记后，直接生成 `decision=passed` 的 GateDecision；
- 不生成新的 `wait_human` 状态，也不要求人类等待；
- GateDecision 的 actor 为 `video-auto-approval`，事件保留策略版本、理由和证据哈希；
- 原有 Schema、质量评审、预算、授权、供应商资格、append-only 事件和 `block` 规则不变；
- `VIDEO_AUTO_APPROVAL=0` 是唯一回滚开关，恢复旧待审批路径。

这不是“跳过门”，而是把门的人类裁决环节替换成可审计的系统裁决。质量检查失败仍进入
`repair / reconcile / blocked / failed`，不得因自动审批策略而通过。

读模型额外提供机器可读 `nextAction`（`run_node / wait_approval / repair / reconcile /
wait_resource / manual_fix / done`）和结构化 blocker。只读 tRPC：

- `video.pipelineControl.status`
- `video.pipelineControl.events`
- `video.pipelineControl.artifacts`
- `video.pipelineControl.gates`

## 回滚

1. 设置 `PIPELINE_CONTROL_SHADOW=0`，停止新观察写入；
2. 旧 Studio/Director/Film/Explainer/Delivery 执行逻辑无需变更即可继续；
3. 保留 0055 表和事件用于审计；需要物理回退时先确认新控制面无外部读取，再单独执行回退迁移；
4. 不删除旧 `production_stage_runs.status`、`stages.jsonl` 或交付版本证据。

## 与外部融合方案的吸收边界

已吸收：三轴 + `nextAction`、结构化 GateFinding、artifact manifest hash、StageRun itemKey、只读
状态/事件/产物/门裁决查询，以及旧恢复工具兼容筛选。

暂不吸收：RepairPlan / playbook / 自动修复、总制片人 Agent、资源租约池、vendor 内部拆段和真实
执行默认切换。跨仓共享核心也不在本仓隔离任务中执行；公共化必须先走提案，不得违反
`none-in-none-out`。

## 一期验收

- 6 条现有管线均可编译，planHash 可重复；
- 相同命令和输入不会创建第二次运行/阶段；
- GateDecision 只能绑定当前 StageRun 已登记的产物 SHA-256；
- Studio、Director、Film 共用同一项目执行租约；
- 影子写入失败不改变旧执行器结果；
- 从事件可重建读模型，旧表和旧日志保持可读；
- 不发送任何新的模型、图像、视频、发布或客户外呼请求。
