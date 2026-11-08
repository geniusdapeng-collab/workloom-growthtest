# 视频提示词有界局部修复

## 目标

把 G6、营销事实审核或原生相机检查的拒绝转换为可定位的镜头问题单，只修复受影响的镜头，并在有限轮次内重新审核。该机制解决“一个坏镜头导致整包重做”，不降低任何现有质量、授权或预算门槛。

## 不变的字段合同

本机制不改变最终提示词合同：

- 仍使用原有 25 个标准字段，不增加、删除、重命名或重排；
- 字段含义、最低长度和当前场景类型的可省略规则保持不变；
- 片头仍为原有 25 个字段加 5 个片头专属字段；
- 每镜仍受 3000 Unicode 字符硬上限约束；
- `PromptFinding`、`PromptRepairPlan`、镜头断点、ShotPlan 和 metrics 都是旁路元数据，不写入最终提示词。

## 执行顺序

```text
原生提示词生产
→ prompt preflight（全视频，在定妆照和媒体之前）
→ 营销逐镜事实预检
→ 最终 G6
→ 结构化 findings
→ 修复计划
→ 只重写目标镜头
→ 包级复验
→ 最多两轮
→ prompt-ready 或明确失败
```

`prompt-review` 工作单跳过额外 preflight，直接使用正式的提示词评审阶段；完整视频在定妆照和媒体生成前执行同一 G6 质量逻辑。

## 修复预算

- `PROMPT_REPAIR_MAX_ROUNDS=2`：默认最多两轮局部修复；
- `PROMPT_REPAIR_MAX_CALLS=32`：整个修复循环的供应商文字调用硬上限；作者、来源提取和评审在发请求前统一预占，耗尽后不再发下一次请求；
- `PROMPT_REPAIR_MAX_CALLS_PER_SHOT=8`：每个目标镜头的作者调用硬上限；
- 同一 finding 连续两轮无变化时返回 `PROMPT_REPAIR_NO_PROGRESS`；
- `human_input` finding 不自动修复，直接保留阻塞；
- 修复阶段只允许文字模型，不提交图片、视频、发布或外呼；
- 供应商结果未知时保留原工作单并先对账，不新增付费请求。

## 局部失效

`workloom.prompt-repair-plan/v1` 绑定：

- 项目、revision、round 和原提示词集合 SHA-256；
- `shotId`、字段路径、expected / actual、证据和修复类型；
- 目标镜头当前行 SHA-256；
- 相邻镜头 ID，用于连续性复核；
- `workloom.video-shot/v1` ShotPlan；
- `workloom.video-prompt-artifact/v1` 目标镜头的字段与正文。

未命中的已完全合格镜头直接复用原行；相邻镜头只重验连续性，不默认重写。全局 finding 才允许扩大为包级修复。

## 审核与回执

- 结构化 finding 最终映射到现有控制面的 `GateFinding`；
- 超过 30k 字符的 G6 提示词报告按完整镜头边界分批评审，整包概览保留在每批；无法按镜头边界切分的超长正文直接失败关闭；
- preflight 记为 `video.prompt.preflight`，不会冒充正式 G6 的 `prompt.confirm`；
- 最终 G6/FACT 的真实裁决仍写入原事件账本；
- 修复请求、完成、阻塞和耗尽分别写入 `pipeline.prompt.repair_*` 事件；
- `video.studio.promptMetrics` 返回营销、叙事和未知片型分桶的 preflight/G6/修复漏斗。

## 开关和回滚

```env
PROMPT_REPAIR_ENABLED=1
PROMPT_REPAIR_MAX_ROUNDS=2
PROMPT_REPAIR_MAX_CALLS=32
PROMPT_REPAIR_MAX_CALLS_PER_SHOT=8
PROMPT_FACT_PREFLIGHT=1
PROMPT_PREFLIGHT_REQUIRED=1
```

- 全部置 0 可恢复原有整包重跑/显式 `resume-prompts` 行为；
- 新增断点与事件保留为审计证据，回滚不删除历史；
- 回滚不会放宽 25 字段、3000 字符、G6、FACT、授权或预算合同。
